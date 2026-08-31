/**
 * Round-7 cross-component audit — confirmed red tests.
 *
 * These cases sit at component boundaries and are intentionally kept apart
 * from the router/core/middleware agents' focused files.
 */

import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import type { Context } from "../src/core/context/context.ts";
import { streamText } from "../src/helpers/streams.ts";
import { cache } from "../src/middleware/cache.ts";

const request = (path = "/"): Request => new Request(`http://localhost:3000${path}`);

describe("R7-CROSS-1 responseCache preserves representation bytes", () => {
  it("replays an encoded textual Response byte-for-byte", async () => {
    const packed = new Uint8Array(gzipSync("hello"));
    let computed = 0;
    const app = createApp({ env: "test" });
    app.get("/encoded", cache(), () => {
      computed++;
      return new Response(packed, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-encoding": "gzip",
        },
      });
    });

    const first = await app.handle(request("/encoded"));
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    const second = await app.handle(request("/encoded"));
    const secondBytes = new Uint8Array(await second.arrayBuffer());

    // Repro: textualBody() decodes compressed bytes through Response.text().
    // Expected: a cached representation is byte-identical. Actual: invalid
    // UTF-8 bytes become U+FFFD and are re-encoded on the hit.
    // Root cause: src/middleware/cache.ts:60-69.
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(secondBytes).toEqual(firstBytes);
    expect(computed).toBe(1);
  });
});

describe("R7-CROSS-2 stream cancellation is sticky", () => {
  it("runs an onAbort callback registered after cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cleaned = false;
    const response = streamText({} as Context, async (writer) => {
      await gate;
      writer.onAbort(() => {
        cleaned = true;
      });
    });

    // Repro: cancel() drains the callback array while it is empty. The
    // producer resumes later and appends cleanup to an already-drained array.
    // Expected: cancellation is state, so late registration runs immediately.
    // Actual: the cleanup is lost forever.
    // Root cause: src/helpers/streams.ts:62-64,82-90.
    const cancelling = response.body!.cancel("consumer stopped");
    release();
    await cancelling;
    await Promise.resolve();
    expect(cleaned).toBe(true);
  });
});
