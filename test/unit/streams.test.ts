/**
 * Streaming helper tests: writers, close, abort cleanup, SSE wire format,
 * sanitization, heartbeat and error containment.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { stream, streamText, streamSSE } from "../../src/helpers/streams.ts";
import { readAllLimited, repumpResponse, repumpStream } from "../../src/utils/streams.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("stream / streamText", () => {
  it("writes chunks, closes, and exposes desiredSize", async () => {
    const app = new Keala(quiet);
    let observed: number | null = null;
    app.get("/x", (c) =>
      streamText(c, async (w) => {
        w.write("hello ");
        observed = w.desiredSize;
        w.write("world");
        w.close();
      }),
    );
    const res = await app.handle(req("/x"));
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("hello world");
    expect(observed).not.toBeNull();
  });

  it("binary chunks round-trip byte-exact", async () => {
    const app = new Keala(quiet);
    app.get("/b", (c) =>
      stream(c, async (w) => {
        w.write(new Uint8Array([1, 2, 255, 0]));
      }),
    );
    const res = await app.handle(req("/b"));
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 255, 0]);
  });

  it("abort cleanup runs when the consumer cancels", async () => {
    const app = new Keala(quiet);
    let cleaned = false;
    app.get("/s", (c) =>
      streamText(c, async (w) => {
        w.onAbort(() => {
          cleaned = true;
        });
        // Keep the stream open until cancelled.
        await new Promise((resolve) => setTimeout(resolve, 500));
        w.write("late");
      }),
    );
    const res = (await app.handle(req("/s"))) as Response;
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("client gone");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cleaned).toBe(true);
  });

  it("callback errors never leak their message to the client", async () => {
    const app = new Keala(quiet);
    app.get("/e", (c) =>
      streamText(c, async () => {
        throw new Error("secret-producer-failure");
      }),
    );
    const res = await app.handle(req("/e"));
    await expect(res.text()).rejects.toThrow(); // stream errors, no body text
  });
});

describe("streamSSE", () => {
  it("serializes events per the wire format (multiline data, json objects)", async () => {
    const app = new Keala(quiet);
    app.get("/ev", (c) =>
      streamSSE(
        c,
        async (sse) => {
          sse.send({ event: "greet", data: "line1\nline2", id: "42" });
          sse.send({ data: { n: 1 } });
          sse.send({ data: "x", retry: 2500 });
        },
        { heartbeat: 0 },
      ),
    );
    const res = await app.handle(req("/ev"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const text = await res.text();
    expect(text).toContain("event: greet\nid: 42\ndata: line1\ndata: line2\n\n");
    expect(text).toContain('data: {"n":1}\n\n');
    expect(text).toContain("retry: 2500\ndata: x\n\n");
  });

  it("sanitizes CR/LF in event and id fields (no header smuggling)", async () => {
    const app = new Keala(quiet);
    app.get("/sneaky", (c) =>
      streamSSE(
        c,
        async (sse) => {
          sse.send({ event: "a\r\ninjected: 1", id: "7\r\nx: y", data: "d" });
        },
        { heartbeat: 0 },
      ),
    );
    const res = await app.handle(req("/sneaky"));
    const text = await res.text();
    // CR/LF collapse to spaces: the payload can never start a new frame line.
    const lines = text.split("\n");
    expect(lines.some((line) => line.startsWith("injected:") || line.startsWith("x:"))).toBe(false);
    expect(lines[0]).toBe("event: a  injected: 1");
  });

  it("heartbeat comments flow while the stream is idle", async () => {
    const app = new Keala(quiet);
    app.get("/idle", (c) =>
      streamSSE(
        c,
        async (sse) => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          sse.send({ data: "done" });
        },
        { heartbeat: 25 },
      ),
    );
    const res = await app.handle(req("/idle"));
    const text = await res.text();
    const pings = text.split(": ping").length - 1;
    expect(pings).toBeGreaterThanOrEqual(1);
    expect(text).toContain("data: done");
  });

  // SRC-REGRESSION (U3c): the state-mode finalizer's onStreamError wiring
  // (old respond.ts streamHook → repumpStream on the staged body) was
  // deleted with the setter family and NOT re-homed onto the committed
  // Response path — grep src/ for `onStreamError` consumers: only the
  // constructor assignment survives. The rewritten return-style tests are
  // therefore expected to FAIL until the hook is re-wired (e.g. in
  // finishCommitted); flip `it.fails` back to `it` when it is.
  it("opt-in stream error observation reaches the app hook (AppOptions.onStreamError)", async () => {
    const seen: string[] = [];
    const app = new Keala({
      env: "test",
      onStreamError: (err) => {
        seen.push(err.message);
      },
    });
    app.get("/boom", () => {
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("part"));
          await new Promise((resolve) => setTimeout(resolve, 10));
          controller.error(new Error("stream-exploded"));
        },
      });
      return new Response(body);
    });
    const res = await app.handle(req("/boom"));
    await expect(res.text()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toEqual(["stream-exploded"]);
  });
});

describe("onStreamError observation (opt-in wrapper)", () => {
  it("pump is pull-driven: a stalled consumer stops the source reads", async () => {
    const app = new Keala(quiet);
    const seen: Error[] = [];
    const observed = new Keala({ ...quiet, onStreamError: (e) => seen.push(e) });
    let sourceReads = 0;
    // A source that counts reads and yields slowly.
    const slowSource = () =>
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          sourceReads++;
          await new Promise((r) => setTimeout(r, 5));
          controller.enqueue(new Uint8Array([1]));
        },
      });
    observed.get("/x", () => new Response(slowSource()));
    const res = await observed.handle(req("/x"));
    expect(seen).toEqual([]);
    // Read exactly one chunk, then hold the reader open without reading.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const readsAtPull = sourceReads;
    // Give the wrapper ample time to over-produce if it were eager —
    // a pull-driven pump must NOT read ahead of the consumer.
    await new Promise((r) => setTimeout(r, 80));
    expect(sourceReads).toBeLessThanOrEqual(readsAtPull + 2); // small scheduler slack only
    await reader.cancel();
    void app;
  });

  // SRC-REGRESSION (U3c): see the note above — onStreamError is unwired.
  it("producer errors reach the hook and the client sees the stream fail", async () => {
    const seen: Error[] = [];
    const observed = new Keala({ ...quiet, onStreamError: (e) => seen.push(e) });
    observed.get("/x", () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("producer blew up"));
          },
        }),
      );
    });
    const res = await observed.handle(req("/x"));
    const reader = res.body!.getReader();
    await expect(reader.read()).rejects.toThrow(/producer blew up/);
    expect(seen.map((e) => e.message)).toEqual(["producer blew up"]);
  });
});

/**
 * Unit tests for the shared stream primitives (utils/streams.ts, review
 * DEAD-20/21): the re-pump hook matrix and the limited whole-body read the
 * pool / lifecycle / respond / body-parser / node-source call sites share.
 */

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
