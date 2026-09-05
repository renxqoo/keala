import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { cache } from "../../src/middleware/cache.ts";
/**
 * responseCache tests: hits rebuild fresh Responses, eligibility is
 * conservative, TTL/LRU behave, and captures never disturb the live response.
 */

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("responseCache", () => {
  it("misses compute, hits replay identical bodies with x-cache markers", async () => {
    let computed = 0;
    const app = new Keala(quiet);
    app.get("/heavy", cache(), (c) => {
      computed += 1;
      return c.json({ n: computed });
    });
    const first = await app.handle(req("/heavy"));
    expect(first.headers.get("x-cache")).toBeNull();
    expect(await first.text()).toBe('{"n":1}');
    const second = await app.handle(req("/heavy"));
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(await second.text()).toBe('{"n":1}');
    expect(computed).toBe(1);
  });

  it("each hit is a FRESH Response instance (repeatable bodies)", async () => {
    const app = new Keala(quiet);
    app.get("/x", cache(), (c) => c.text("replayable"));
    for (let i = 0; i < 3; i++) {
      const res = await app.handle(req("/x"));
      expect(await res.text()).toBe("replayable");
    }
  });

  it("HEAD hits serve stripped bodies with Content-Length", async () => {
    const app = new Keala(quiet);
    app.get("/x", cache(), (c) => c.text("12345"));
    await app.handle(req("/x")); // warm
    const head = await app.handle(new Request("http://localhost:3000/x", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("x-cache")).toBe("hit");
    expect(head.headers.get("content-length")).toBe("5");
    expect(await head.text()).toBe("");
  });

  it("keys are per-path; includeQuery opts the query in", async () => {
    const seen: string[] = [];
    const app = new Keala(quiet);
    app.get("/q", cache(), (c) => {
      seen.push(c.querystring);
      return c.text(`qs:${c.querystring}`);
    });
    // Default: any query string bypasses the cache entirely (never replays
    // one query's answer to another), so every request computes.
    await app.handle(req("/q?a=1"));
    await app.handle(req("/q?a=1"));
    await app.handle(req("/q?a=2"));
    expect(seen).toEqual(["a=1", "a=1", "a=2"]);

    const keyed = new Keala(quiet);
    const hits: string[] = [];
    keyed.get("/k", cache({ includeQuery: true }), (c) => {
      hits.push(c.querystring);
      return c.text(`k:${c.querystring}`);
    });
    await keyed.handle(req("/k?a=1"));
    await keyed.handle(req("/k?a=1"));
    await keyed.handle(req("/k?a=2"));
    expect(hits).toEqual(["a=1", "a=2"]);
  });

  it("TTL expiry recomputes", async () => {
    let computed = 0;
    const app = new Keala(quiet);
    app.get("/t", cache({ ttl: 15 }), (c) => {
      computed += 1;
      return c.text(`v${computed}`);
    });
    expect(await (await app.handle(req("/t"))).text()).toBe("v1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await (await app.handle(req("/t"))).text()).toBe("v2");
  });

  it("LRU evicts the oldest beyond max", async () => {
    const app = new Keala(quiet);
    app.get("/l/:id", cache({ max: 2 }), (c) => c.text(`id:${c.params["id"]}`));
    await app.handle(req("/l/1"));
    await app.handle(req("/l/2"));
    await app.handle(req("/l/3")); // evicts /l/1
    const replay = await app.handle(req("/l/1"));
    expect(replay.headers.get("x-cache")).toBeNull(); // recomputed
    const kept = await app.handle(req("/l/3"));
    expect(kept.headers.get("x-cache")).toBe("hit");
  });

  it("ineligible responses never cache", async () => {
    const app = new Keala(quiet);
    app.get("/post-only", cache(), (c) => c.text("mutated"));
    app.get("/private", cache(), (c) => {
      c.setHeader("Cache-Control", "private");
      return c.text("secret");
    });
    app.get("/cookied", cache(), (c) => {
      c.cookies.set("sid", "1");
      return c.text("session");
    });
    app.get("/nostream", cache(), (c) => {
      c.status = 201;
      return c.text("created");
    });
    const post = await app.handle(req("/post-only", { method: "POST", body: "x" }));
    expect(post.headers.get("x-cache")).toBeNull();
    for (const path of ["/private", "/cookied", "/nostream"]) {
      const first = await app.handle(req(path));
      const second = await app.handle(req(path));
      expect(first.headers.get("x-cache")).toBeNull();
      expect(second.headers.get("x-cache")).toBeNull();
    }
  });

  it("authorization-bearing requests bypass storage and replay", async () => {
    let computed = 0;
    const app = new Keala(quiet);
    app.get("/auth", cache(), (c) => {
      computed += 1;
      return c.text(`v${computed}`);
    });
    await app.handle(
      new Request("http://localhost:3000/auth", { headers: { authorization: "Bearer x" } }),
    );
    await app.handle(
      new Request("http://localhost:3000/auth", { headers: { authorization: "Bearer x" } }),
    );
    expect(computed).toBe(2);
    // An anonymous request warms the cache; authorized ones still bypass.
    await app.handle(req("/auth"));
    await app.handle(
      new Request("http://localhost:3000/auth", { headers: { authorization: "Bearer x" } }),
    );
    expect(computed).toBe(3);
  });

  it("binary (non-textual) bodies are not captured", async () => {
    const app = new Keala(quiet);
    app.get("/bin", cache(), (c) => {
      c.body = new Uint8Array([1, 2, 3]);
    });
    const first = await app.handle(req("/bin"));
    const second = await app.handle(req("/bin"));
    expect(second.headers.get("x-cache")).toBeNull();
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

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
    app.get("/bytes", cache(), () => {
      runs++;
      const bytes = new Uint8Array(256);
      for (let i = 0; i < 256; i++) bytes[i] = i;
      return new Response(bytes);
    });
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
    app.get("/big", cache({ maxEntryBytes: 1024 }), (c) => {
      runs++;
      return c.text("x".repeat(4096));
    });
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
