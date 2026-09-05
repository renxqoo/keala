/**
 * compress × CompressionStream: functional contract of the Web-standard
 * default gzip. Decompression is verified with node:zlib's gunzipSync —
 * an INDEPENDENT implementation from the producer — on both runtimes.
 */

import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { compress } from "../../src/middleware/etag.ts";

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
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/b", (c) => {
      return c.text(body as string);
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
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/big", (c) => {
      return c.text(body);
    });
    const res = await app.handle(req("/big", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const restored = new TextDecoder().decode(gunzipSync(new Uint8Array(await res.arrayBuffer())));
    expect(restored).toBe(body);
    expect(restored.length).toBeGreaterThan(1_000_000);
  });

  it("object bodies compress; original semantics preserved", async () => {
    const app = new Keala(quiet);
    app.use(compress());
    const payload = { hello: "world", rows: Array.from({ length: 32 }, (_, i) => ({ id: i })) };
    app.get("/o", (c) => {
      return c.json(payload);
    });
    const res = await app.handle(req("/o", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const restored = JSON.parse(
      new TextDecoder().decode(gunzipSync(new Uint8Array(await res.arrayBuffer()))),
    );
    expect(restored).toEqual(payload);
  });

  it("pass-through rules: tiny bodies, streams, no accept-encoding", async () => {
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/tiny", (c) => {
      return c.text("x");
    });
    app.get(
      "/stream",
      () =>
        // U3c gate (§2.3-5): streams are NEVER transformation-eligible —
        // only snapshot-identity sugar products are.
        new Response(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
        ),
    );
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
    // U3c: bytes can only ride a hand-built Response, which passes the
    // identity gate outright — so the packed>=bytes rule is exercised with
    // an injected identity "gzip" over a compressible SUGAR body (packing
    // never shrinks), and the byte route doubles as the hand-built lock.
    const app = new Keala(quiet);
    const random = new Uint8Array(2048);
    crypto.getRandomValues(random);
    app.get("/rand", () => new Response(random));
    app.use(compress({ gzip: (input) => Promise.resolve(input) }));
    app.get("/packed", (c) => c.text("0".repeat(400)));
    const res = await app.handle(req("/rand", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(2048);
    const packed = await app.handle(req("/packed", { headers: { "accept-encoding": "gzip" } }));
    expect(packed.headers.get("content-encoding")).toBeNull();
    expect(await packed.text()).toBe("0".repeat(400));
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
      const app = new Keala(quiet);
      app.use(compress());
      app.get("/c", (c) => {
        return c.text("concurrent-compressible-body-".repeat(32));
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
