/**
 * R4.10 audit regressions — responseCache data-plane findings:
 *
 *  DP-P0  a streamed committed response is never captured (consuming an
 *         unknown stream inside the onion deadlocked infinite producers
 *         and double-buffered finite ones before the client saw a byte).
 *  DP-P1  a committed body without an explicit TEXTUAL content-type is
 *         never captured (`.text()` round-trips corrupted binary replays
 *         with U+FFFD).
 *  DP-P1  the store is byte-budgeted (`maxBytes`/`maxEntryBytes`) — the
 *         entry-count LRU alone retained a process-sized heap.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/index.ts";
import { cache } from "../src/middleware/cache.ts";

const quiet = { env: "test" } as const;
const request = (path: string): Request => new Request(`http://localhost${path}`);

describe("audit DP-P0: streamed responses are never captured", () => {
  it("an infinite stream settles immediately and never caches", async () => {
    const app = new Keala(quiet);
    app.get(
      "/inf",
      cache({ ttl: 60_000 }),
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("chunk"));
            },
          }),
          { headers: { "content-type": "text/plain" } },
        ),
    );
    const settled = await Promise.race([
      app.handle(request("/inf")).then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    expect(settled).toBe("settled");
    const second = await app.handle(request("/inf"));
    expect(second.headers.get("x-cache")).toBeNull();
  });

  it("a finite stream is handed back without full buffering", async () => {
    const app = new Keala(quiet);
    app.get(
      "/finite",
      cache(),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("part-one"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/plain" } },
        ),
    );
    const first = await app.handle(request("/finite"));
    expect(await first.text()).toBe("part-one"); // delivered un-captured
    const second = await app.handle(request("/finite"));
    expect(second.headers.get("x-cache")).toBeNull();
  });
});

describe("audit DP-P1: binary committed bodies never corrupt", () => {
  it("a committed body without a textual content-type is declined, replays recompute", async () => {
    const app = new Keala(quiet);
    let runs = 0;
    app.get(
      "/bytes",
      cache(),
      () => {
        runs++;
        const bytes = new Uint8Array(256);
        for (let i = 0; i < 256; i++) bytes[i] = i;
        return new Response(bytes);
      },
    );
    const first = await app.handle(request("/bytes"));
    expect(new Uint8Array(await first.arrayBuffer())[128]).toBe(128);
    const second = await app.handle(request("/bytes"));
    expect(second.headers.get("x-cache")).toBeNull();
    expect(runs).toBe(2);
    expect(new Uint8Array(await second.arrayBuffer())[128]).toBe(128);
  });

  it("a textual sugar commit with an explicit type still caches", async () => {
    const app = new Keala(quiet);
    let runs = 0;
    app.get("/txt", cache(), (c) => {
      runs++;
      return c.text("payload");
    });
    await app.handle(request("/txt"));
    const second = await app.handle(request("/txt"));
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(await second.text()).toBe("payload");
    expect(runs).toBe(1);
  });
});

describe("audit DP-P1: the store is byte-budgeted", () => {
  it("maxBytes evicts LRU beyond the byte budget", async () => {
    const app = new Keala(quiet);
    const page = "p".repeat(1024 * 1024); // ~1MiB textual bodies
    const shared = cache({ maxBytes: 2 * 1024 * 1024, max: 10 });
    app.get("/a", shared, (c) => c.text(page));
    app.get("/b", shared, (c) => c.text(page));
    app.get("/c", shared, (c) => c.text(page));
    await app.handle(request("/a"));
    await app.handle(request("/b"));
    await app.handle(request("/c")); // over budget -> /a evicted
    // Assert the SURVIVORS first: touching /a recomputes and re-seeds it,
    // which would evict /b before its own assertion runs.
    expect((await app.handle(request("/b"))).headers.get("x-cache")).toBe("hit");
    expect((await app.handle(request("/c"))).headers.get("x-cache")).toBe("hit");
    expect((await app.handle(request("/a"))).headers.get("x-cache")).toBeNull();
  });

  it("a single entry larger than maxEntryBytes is declined outright", async () => {
    const app = new Keala(quiet);
    let runs = 0;
    app.get(
      "/big",
      cache({ maxEntryBytes: 1024 }),
      (c) => {
        runs++;
        return c.text("x".repeat(4096));
      },
    );
    await app.handle(request("/big"));
    const second = await app.handle(request("/big"));
    expect(second.headers.get("x-cache")).toBeNull();
    expect(runs).toBe(2);
  });

  it("HEAD replay uses the stored byte length without re-encoding", async () => {
    const app = new Keala(quiet);
    app.get("/h", cache(), (c) => c.text("hello"));
    await app.handle(request("/h"));
    const head = await app.handle(new Request("http://localhost/h", { method: "HEAD" }));
    expect(head.headers.get("content-length")).toBe("5");
    expect(head.headers.get("x-cache")).toBe("hit");
  });
});
