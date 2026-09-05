/**
 * Round-7 cross-component audit — confirmed red tests.
 *
 * These cases sit at component boundaries and are intentionally kept apart
 * from the router/core/middleware agents' focused files.
 */

import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import type { Context } from "../../src/core/context/context.ts";
import { streamText } from "../../src/helpers/streams.ts";
import { cache } from "../../src/middleware/cache.ts";

const request = (path = "/"): Request => new Request(`http://localhost:3000${path}`);

describe("R7-CROSS-1 responseCache preserves representation bytes", () => {
  it("encoded representations are outside the capture surface; unencoded replays byte-for-byte", async () => {
    // R4.10: the ONLY capturable bodies are unencoded framework snapshots
    // (sugar/state-mode strings and JSON text). A pre-encoded payload is
    // either a hand-built Response (declined — streamed and no-CT bodies
    // corrupted replays) or a byte state body (declined by the textual
    // guard) — the old `.text()` corruption path is structurally gone.
    const packed = new Uint8Array(gzipSync("hello"));
    let encodedCalls = 0;
    let plainCalls = 0;
    const app = new Keala({ env: "test" });
    app.get("/encoded", cache(), (c) => {
      encodedCalls++;
      c.setHeader("Content-Type", "text/plain; charset=utf-8");
      c.setHeader("Content-Encoding", "gzip");
      c.body = packed;
    });
    app.get("/plain", cache(), (c) => {
      plainCalls++;
      return c.text("hello");
    });

    const first = await app.handle(request("/encoded"));
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    const second = await app.handle(request("/encoded"));
    const secondBytes = new Uint8Array(await second.arrayBuffer());
    expect(second.headers.get("x-cache")).toBeNull(); // declined, recomputed
    expect(secondBytes).toEqual(firstBytes); // and STILL byte-identical
    expect(encodedCalls).toBe(2);

    await app.handle(request("/plain"));
    const plainHit = await app.handle(request("/plain"));
    expect(plainHit.headers.get("x-cache")).toBe("hit");
    expect(await plainHit.text()).toBe("hello");
    expect(plainCalls).toBe(1);
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
