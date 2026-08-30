/**
 * Final red-team round (P4) regression locks — one suite per finding:
 *  RT-F1 pooling leaks the previous request's parsed body / validated value
 *  RT-F2 a rejecting async ws handler crashes the process (unhandledRejection)
 *  RT-F3 responseCache silently disabled for no-content-type bodies (real Bun)
 *  RT-F4 csrf fallback MAC session-binding bypass via NUL delimiter shift
 *  RT-F5 HEAD on large committed responses buffers the whole body
 *  RT-F6 pooling × websocket retires a context the socket still holds
 *  RT-F7 c.append() skips header-NAME validation; record inherits Object.prototype
 *  RT-F8 cache HEAD replay computes UTF-16 Content-Length
 *  RT-F9 etag middleware ignores If-None-Match: *
 *  RT-F10 redirect Location percent-encodes UTF-16 code units, not UTF-8
 */

import { describe, expect, it } from "vitest";

import { createApp, startBunServer, type ServeImplementation } from "../src/index.ts";
import { createBodyParser } from "../src/plugins/body-parser.ts";
import { cache } from "../src/middleware/cache.ts";
import { csrfToken } from "../src/middleware/csrf-token.ts";
import { etag } from "../src/middleware/etag.ts";
import { validator } from "../src/middleware/validator.ts";

const quiet = { env: "test" } as const;
const readJson = (body: unknown): { json(): Promise<unknown> } =>
  body as { json(): Promise<unknown> };
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

// ---------------------------------------------------------------------------
describe("RT-F1: pooling never leaks parsed bodies or validated values", () => {
  it("a recycled context does not serve the previous request's body", async () => {
    const app = createApp({ ...quiet, pooling: true });
    app.use(createBodyParser());
    const readJson = (body: unknown): { json(): Promise<unknown> } =>
      body as { json(): Promise<unknown> };
    app.post("/alice", async (c) =>
      c.json({ got: await readJson((c as unknown as { req: unknown }).req).json() }),
    );
    app.post("/bob", async (c) =>
      c.json({ got: await readJson((c as unknown as { req: unknown }).req).json() }),
    );
    const alice = await app.handle(
      req("/alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: "ALICE_PRIVATE_TOKEN" }),
      }),
    );
    expect(await alice.json()).toEqual({ got: { secret: "ALICE_PRIVATE_TOKEN" } });
    // Sequential requests reuse the just-released pool slot.
    const bob = await app.handle(
      req("/bob", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ who: "bob" }),
      }),
    );
    expect(await bob.json()).toEqual({ got: { who: "bob" } });
  });

  it("a recycled context does not leak c.valid into validator-less routes", async () => {
    const schema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value: unknown) {
          return typeof value === "object" && value !== null
            ? { value }
            : { issues: [{ message: "object required" }] };
        },
      },
    } as const;
    const app = createApp({ ...quiet, pooling: true });
    app.use(createBodyParser());
    app.post("/v", validator(schema), (c) =>
      c.json((c as unknown as { valid?: unknown }).valid ?? null),
    );
    app.post("/plain", async (c) => {
      void (await readJson((c as unknown as { req: unknown }).req).json());
      c.body = { leaked: (c as unknown as { valid?: unknown }).valid ?? null };
    });
    await app.handle(
      req("/v", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: "VAL" }),
      }),
    );
    const plain = await app.handle(
      req("/plain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ who: "bob" }),
      }),
    );
    expect(await plain.json()).toEqual({ leaked: null });
  });
});

// ---------------------------------------------------------------------------
describe("RT-F2: rejecting async ws handlers never crash the process", () => {
  const fakeServe = (): { impl: ServeImplementation; options: () => Record<string, unknown> } => {
    let captured: Record<string, unknown> = {};
    const impl: ServeImplementation = (options) => {
      captured = options;
      return {
        port: 0,
        hostname: "localhost",
        stop: () => undefined,
        fetch: () => new Response("fake"),
        reload: () => undefined,
      };
    };
    return { impl, options: () => captured };
  };

  it("open/message rejections route to app.onerror, not unhandledRejection", async () => {
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
      const seen: Error[] = [];
      app.onError((err) => seen.push(err));
      app.ws("/ws", {
        open: async () => {
          throw new Error("ws-open-boom");
        },
        message: async () => {
          throw new Error("ws-msg-boom");
        },
      });
      const { impl, options } = fakeServe();
      startBunServer(app, {}, undefined, impl);
      const handlers = options()["websocket"] as Record<
        string,
        (ws: unknown, ...rest: unknown[]) => void
      >;
      handlers["open"]?.({ data: { wsKey: "/ws", ctx: { path: "/ws" } } });
      handlers["message"]?.({ data: { wsKey: "/ws", ctx: { path: "/ws" } } }, "hi");
      await new Promise((r) => setTimeout(r, 20));
      expect(seen.map((e) => e.message)).toEqual(["ws-open-boom", "ws-msg-boom"]);
      expect(unhandled).toEqual([]);
    } finally {
      (process.off as (event: string, fn: (reason: unknown) => void) => void)(
        "unhandledRejection",
        onUnhandled,
      );
    }
  });
});

// ---------------------------------------------------------------------------
describe("RT-F3: responseCache caches no-content-type bodies (real-Bun shape)", () => {
  it("a bare string Response (no CT header) is cacheable", async () => {
    const app = createApp(quiet);
    let calls = 0;
    app.get("/x", cache({ ttl: 60_000 }), () => {
      calls += 1;
      // No content-type: exactly what `new Response(string)` looks like on
      // the real Bun runtime at cache-capture time.
      return new Response(`plain-${calls}`);
    });
    const first = await app.handle(req("/x"));
    expect(first.headers.get("x-cache")).toBeNull(); // computed fresh
    const second = await app.handle(req("/x"));
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(await second.text()).toBe("plain-1");
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("RT-F4: csrf fallback MAC is NUL-delimiter-attack-proof", () => {
  it("a sessionId containing NUL cannot be re-bound to a shorter session", () => {
    const service = csrfToken({ secret: "s" });
    const token = service.issue("a\u0000b");
    expect(service.verify(token, "a")).toBe(false);
    expect(service.verify(token, "a\u0000b")).toBe(true);
  });

  it("tokens containing literal NUL never verify", () => {
    const service = csrfToken({ secret: "s" });
    expect(service.verify("t1.a\u0000b.1000.60000.x")).toBe(false);
    expect(service.verify("t1.n.1\u00002.60000.x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("RT-F5: HEAD on committed responses never buffers unbounded bodies", () => {
  it("small committed bodies backfill an exact Content-Length", async () => {
    const app = createApp(quiet);
    app.get("/small", () => new Response("hello world"));
    const res = await app.handle(new Request("http://localhost:3000/small", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("11");
    expect(await res.text()).toBe("");
  });

  it("bodies over the 1 MiB budget omit Content-Length instead of buffering", async () => {
    const app = createApp(quiet);
    const big = "x".repeat(2 * 1024 * 1024);
    app.get("/big", () => new Response(big));
    const res = await app.handle(new Request("http://localhost:3000/big", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    // The header is absent — computing it would require reading 2 MiB.
    expect(res.headers.get("content-length")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("RT-F6: pooling and websockets refuse to combine", () => {
  it("app.ws() on a pooled app throws loudly", () => {
    const app = createApp({ ...quiet, pooling: true });
    expect(() => app.ws("/chat", { open: () => undefined })).toThrow(/pooling: true/);
  });
});

// ---------------------------------------------------------------------------
describe("RT-F7: c.append validates header names; the record is prototype-less", () => {
  it("append rejects forbidden/inherited names", () => {
    const app = createApp(quiet);
    app.get("/a", (c) => {
      c.body = "ok";
      expect(() => c.append("constructor", "x")).toThrow(/Invalid header field name/);
      expect(() => c.append("__proto__", "pwn")).toThrow(/Invalid header field name/);
      expect(() => c.append("prototype", "x")).toThrow(/Invalid header field name/);
      expect(() => c.append("bad name", "x")).toThrow(/Invalid header field name/);
    });
    return app.handle(req("/a"));
  });

  it("the header record exposes no inherited keys", () => {
    const app = createApp(quiet);
    app.get("/b", (c) => {
      c.set("X-Ok", "1");
      const record = c.headersRecord;
      expect(record).not.toBeNull();
      expect((record as object)["constructor"]).toBeUndefined();
      expect(Object.getPrototypeOf(record)).toBeNull();
      c.body = "ok";
    });
    return app.handle(req("/b"));
  });
});

// ---------------------------------------------------------------------------
describe("RT-F8: cache HEAD replay Content-Length is byte-exact", () => {
  it("non-ASCII cached bodies report UTF-8 byte length", async () => {
    const app = createApp(quiet);
    app.get(
      "/u",
      cache({ ttl: 60_000 }),
      () => new Response("héllo", { headers: { "content-type": "text/plain" } }),
    );
    await app.handle(req("/u")); // seed
    const head = await app.handle(new Request("http://localhost:3000/u", { method: "HEAD" }));
    expect(head.headers.get("x-cache")).toBe("hit");
    expect(head.headers.get("content-length")).toBe("6"); // é = 2 bytes
  });
});

// ---------------------------------------------------------------------------
describe("RT-F9: etag honors If-None-Match: *", () => {
  it("* matches any representation with 304", async () => {
    const app = createApp(quiet);
    app.get("/e", etag(), (c) => {
      // state mode — return-style commits a Response and bypasses etag
      c.body = "payload";
    });
    const res = await app.handle(req("/e", { headers: { "if-none-match": "*" } }));
    expect(res.status).toBe(304);
  });
});

// ---------------------------------------------------------------------------
describe("RT-F10: redirect Location uses UTF-8 percent-encoding", () => {
  it("latin-1 and astral characters encode as their UTF-8 bytes", async () => {
    const app = createApp(quiet);
    app.get("/r", (c) => {
      c.redirect("/café/😀");
    });
    const res = await app.handle(req("/r"));
    expect(res.headers.get("location")).toBe("/caf%C3%A9/%F0%9F%98%80");
  });

  it("existing percent-escapes and safe ASCII pass through untouched", async () => {
    const app = createApp(quiet);
    app.get("/r2", (c) => {
      c.redirect("/a%20b?q=1&x=/y");
    });
    const res = await app.handle(req("/r2"));
    expect(res.headers.get("location")).toBe("/a%20b?q=1&x=/y");
  });
});
