/**
 * compress × CompressionStream: functional contract of the Web-standard
 * default gzip. Decompression is verified with node:zlib's gunzipSync —
 * an INDEPENDENT implementation from the producer — on both runtimes.
 */

import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import { compress } from "../src/middleware/etag.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("compress (CompressionStream default): wire correctness", () => {
  it.each([
    ["ascii text", "compressible-content-".repeat(40)],
    ["unicode text", "性能测试-🚀-café-".repeat(40)],
    [
      "json-ish",
      JSON.stringify({ rows: Array.from({ length: 64 }, (_, i) => ({ id: i, ok: true })) }),
    ],
  ])("gzip output round-trips byte-exactly (%s)", async (_label, body) => {
    const app = createApp(quiet);
    app.use(compress());
    app.get("/b", (c) => {
      c.body = body as string;
    });
    const res = await app.handle(req("/b", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const packed = new Uint8Array(await res.arrayBuffer());
    const restored = new TextDecoder().decode(gunzipSync(packed));
    expect(restored).toBe(body);
  });

  it("multi-chunk output reassembles correctly (1 MiB body)", async () => {
    // ~1MiB of varied content: forces the readable side to deliver many
    // chunks, exercising the reassembly copy path.
    const chunk = Array.from({ length: 256 }, (_, i) => `seg-${i % 17}-`).join("");
    const body = chunk.repeat(Math.ceil((1024 * 1024) / chunk.length));
    const app = createApp(quiet);
    app.use(compress());
    app.get("/big", (c) => {
      c.body = body;
    });
    const res = await app.handle(req("/big", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const restored = new TextDecoder().decode(gunzipSync(new Uint8Array(await res.arrayBuffer())));
    expect(restored).toBe(body);
    expect(restored.length).toBeGreaterThan(1_000_000);
  });

  it("object bodies compress; original semantics preserved", async () => {
    const app = createApp(quiet);
    app.use(compress());
    const payload = { hello: "world", rows: Array.from({ length: 32 }, (_, i) => ({ id: i })) };
    app.get("/o", (c) => {
      c.body = payload;
    });
    const res = await app.handle(req("/o", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const restored = JSON.parse(
      new TextDecoder().decode(gunzipSync(new Uint8Array(await res.arrayBuffer()))),
    );
    expect(restored).toEqual(payload);
  });

  it("pass-through rules unchanged: tiny bodies, streams, no accept-encoding", async () => {
    const app = createApp(quiet);
    app.use(compress());
    app.get("/tiny", (c) => {
      c.body = "x";
    });
    app.get("/stream", (c) => {
      c.body = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    });
    const tiny = await app.handle(req("/tiny", { headers: { "accept-encoding": "gzip" } }));
    expect(tiny.headers.get("content-encoding")).toBeNull();
    expect(await tiny.text()).toBe("x");
    const streamed = await app.handle(req("/stream", { headers: { "accept-encoding": "gzip" } }));
    expect(streamed.headers.get("content-encoding")).toBeNull();
    const plain = await app.handle(req("/tiny"));
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("vary")).toContain("Accept-Encoding");
  });

  it("incompressible bodies stay uncompressed (packed >= bytes skips)", async () => {
    // Random bytes do not shrink; the component must not ship a body that
    // grew — and must not claim gzip for it.
    const app = createApp(quiet);
    const random = new Uint8Array(2048);
    crypto.getRandomValues(random);
    app.get("/rand", (c) => {
      c.body = random;
    });
    const res = await app.handle(req("/rand", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(2048);
  });

  it("heavy concurrent compression never surfaces unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    (process.on as (event: string, fn: (reason: unknown) => void) => void)(
      "unhandledRejection",
      onUnhandled,
    );
    try {
      const app = createApp(quiet);
      app.use(compress());
      app.get("/c", (c) => {
        c.body = "concurrent-compressible-body-".repeat(32);
      });
      const request = async (): Promise<ArrayBuffer> => {
        const res = await app.handle(req("/c", { headers: { "accept-encoding": "gzip" } }));
        return await res.arrayBuffer();
      };
      // Fire 500 overlapping requests: the stream write/close promises are
      // fire-and-forget — any containment gap would surface here.
      await Promise.all(Array.from({ length: 500 }, request));
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      (process.off as (event: string, fn: (reason: unknown) => void) => void)(
        "unhandledRejection",
        onUnhandled,
      );
    }
  });
});
