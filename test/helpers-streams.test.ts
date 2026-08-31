/**
 * Streaming helper tests: writers, close, abort cleanup, SSE wire format,
 * sanitization, heartbeat and error containment.
 */

import { describe, expect, it } from "vitest";

import { Eleu } from "../src/core/app.ts";
import { stream, streamText, streamSSE } from "../src/helpers/streams.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("stream / streamText", () => {
  it("writes chunks, closes, and exposes desiredSize", async () => {
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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

  it("opt-in stream error observation reaches the app hook (AppOptions.onStreamError)", async () => {
    const seen: string[] = [];
    const app = new Eleu({
      env: "test",
      onStreamError: (err) => {
        seen.push(err.message);
      },
    });
    app.get("/boom", (c) => {
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("part"));
          await new Promise((resolve) => setTimeout(resolve, 10));
          controller.error(new Error("stream-exploded"));
        },
      });
      c.body = body;
    });
    const res = await app.handle(req("/boom"));
    await expect(res.text()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toEqual(["stream-exploded"]);
  });
});

describe("onStreamError observation (opt-in wrapper)", () => {
  it("pump is pull-driven: a stalled consumer stops the source reads", async () => {
    const app = new Eleu(quiet);
    const seen: Error[] = [];
    const observed = new Eleu({ ...quiet, onStreamError: (e) => seen.push(e) });
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
    observed.get("/x", (c) => {
      c.body = slowSource();
    });
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

  it("producer errors reach the hook and the client sees the stream fail", async () => {
    const seen: Error[] = [];
    const observed = new Eleu({ ...quiet, onStreamError: (e) => seen.push(e) });
    observed.get("/x", (c) => {
      c.body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("producer blew up"));
        },
      });
    });
    const res = await observed.handle(req("/x"));
    const reader = res.body!.getReader();
    await expect(reader.read()).rejects.toThrow(/producer blew up/);
    expect(seen.map((e) => e.message)).toEqual(["producer blew up"]);
  });
});
