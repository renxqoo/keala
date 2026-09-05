/**
 * Unit tests for the shared stream primitives (utils/streams.ts, review
 * DEAD-20/21): the re-pump hook matrix and the limited whole-body read the
 * pool / lifecycle / respond / body-parser / node-source call sites share.
 */

import { describe, expect, it } from "vitest";

import { readAllLimited, repumpResponse, repumpStream } from "../src/utils/streams.ts";

const streamOf = (chunks: string[], opts?: { error?: Error }): ReadableStream => {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (opts?.error !== undefined && i === chunks.length) controller.error(opts.error);
      else if (i === chunks.length) controller.close();
      else controller.enqueue(new TextEncoder().encode(chunks[i++] as string));
    },
  });
};

const readAll = async (body: ReadableStream): Promise<string> => {
  const reader = body.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += new TextDecoder().decode(value);
  }
};

describe("repumpStream", () => {
  it("re-pumps every chunk and fires onFinish once on clean end", async () => {
    let finishes = 0;
    const pumped = repumpStream(streamOf(["a", "b", "c"]), { onFinish: () => finishes++ });
    expect(await readAll(pumped)).toBe("abc");
    expect(finishes).toBe(1);
  });

  it("producer errors fire onReadError, error the consumer and finish once", async () => {
    const seen: unknown[] = [];
    let finishes = 0;
    const failure = new Error("producer went boom");
    const pumped = repumpStream(streamOf(["x"], { error: failure }), {
      onReadError: (err) => seen.push(err),
      onFinish: () => finishes++,
    });
    await expect(readAll(pumped)).rejects.toThrow("producer went boom");
    expect(seen).toEqual([failure]);
    expect(finishes).toBe(1);
  });

  it("cancel propagates to the source and finishes once", async () => {
    let cancelled: unknown;
    const source = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    let finishes = 0;
    const pumped = repumpStream(source, { onFinish: () => finishes++ });
    await pumped.cancel("client went away");
    expect(cancelled).toBe("client went away");
    expect(finishes).toBe(1);
  });

  it("a locked body calls onLocked and rethrows the original error", () => {
    const body = streamOf(["a"]);
    void body.getReader(); // lock it
    let locked = 0;
    let finished = 0;
    expect(() =>
      repumpStream(body, {
        onLocked: () => locked++,
        onFinish: () => finished++,
      }),
    ).toThrow(/locked/);
    expect(locked).toBe(1);
    expect(finished).toBe(0);
  });

  it("no hooks is a valid pure re-pump", async () => {
    const pumped = repumpStream(streamOf(["ok"]), {});
    expect(await readAll(pumped)).toBe("ok");
  });
});

describe("repumpResponse", () => {
  it("carries status, statusText and headers verbatim over the pumped body", async () => {
    const source = new Response(streamOf(["bo", "dy"]), {
      status: 201,
      statusText: "Made",
      headers: { "x-keep": "yes" },
    });
    const wrapped = repumpResponse(source, {});
    expect(wrapped).not.toBeNull();
    expect((wrapped as Response).status).toBe(201);
    expect((wrapped as Response).statusText).toBe("Made");
    expect((wrapped as Response).headers.get("x-keep")).toBe("yes");
    expect(await (wrapped as Response).text()).toBe("body");
  });

  it("returns null for a locked body after onLocked fired", async () => {
    const source = new Response(streamOf(["a"]));
    void source.body!.getReader(); // lock the body
    let locked = 0;
    expect(repumpResponse(source, { onLocked: () => locked++ })).toBeNull();
    expect(locked).toBe(1);
  });
});

describe("readAllLimited", () => {
  const tooLarge = (): Error => new Error("too large");

  it("returns the single chunk without copying", async () => {
    const chunk = new Uint8Array([1, 2, 3]);
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const out = await readAllLimited(source as ReadableStream<Uint8Array>, 10, tooLarge);
    expect(out).toBe(chunk);
  });

  it("concatenates multi-chunk bodies byte-exact", async () => {
    const out = await readAllLimited(
      streamOf(["abc", "de"]) as ReadableStream<Uint8Array>,
      10,
      tooLarge,
    );
    expect([...out]).toEqual([..."abcde"].map((ch) => ch.charCodeAt(0)));
  });

  it("an empty body yields the empty array", async () => {
    const out = await readAllLimited(streamOf([]) as ReadableStream<Uint8Array>, 10, tooLarge);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteLength).toBe(0);
  });

  it("crossing the limit cancels the source and throws the injected error", async () => {
    let cancelled = false;
    const source = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(8).fill(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readAllLimited(source as ReadableStream<Uint8Array>, 10, tooLarge),
    ).rejects.toThrow("too large");
    // cancel() runs asynchronously against the locked reader — let it land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  it("a body exactly at the limit passes", async () => {
    const out = await readAllLimited(
      streamOf(["ab", "cd"]) as ReadableStream<Uint8Array>,
      4,
      tooLarge,
    );
    expect(out.byteLength).toBe(4);
  });
});
