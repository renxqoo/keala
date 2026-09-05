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

import { describe, expect, it, vi } from "vitest";

import { Keala, startBunServer, type ServeImplementation } from "../../src/index.ts";
import { createBodyParser } from "../../src/plugins/body-parser.ts";
import { cache } from "../../src/middleware/cache.ts";
import { csrfToken } from "../../src/middleware/csrf-token.ts";
import { etag } from "../../src/middleware/etag.ts";
import { validator } from "../../src/middleware/validator.ts";

const quiet = { env: "test" } as const;
const readJson = (body: unknown): { json(): Promise<unknown> } =>
  body as { json(): Promise<unknown> };
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

// ---------------------------------------------------------------------------
describe("RT-F1: pooling never leaks parsed bodies or validated values", () => {
  it("a recycled context does not serve the previous request's body", async () => {
    const app = new Keala({ ...quiet, pooling: true });
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
    const app = new Keala({ ...quiet, pooling: true });
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
        fetch: async () => new Response("fake"),
        reload: () => undefined,
      };
    };
    return { impl, options: () => captured };
  };

  it("open/message rejections route to the console fallback, not unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    (process.on as (event: string, fn: (reason: unknown) => void) => void)(
      "unhandledRejection",
      onUnhandled,
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // ws runtime errors have no request context — R4.3 routes them to the
      // console fallback (the mapper contract is request-scoped).
      const app = new Keala({ env: "development" });
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
      const logged = consoleError.mock.calls.flat().join(" ");
      expect(logged).toContain("ws-open-boom");
      expect(logged).toContain("ws-msg-boom");
      expect(unhandled).toEqual([]);
      consoleError.mockRestore();
    } finally {
      (process.off as (event: string, fn: (reason: unknown) => void) => void)(
        "unhandledRejection",
        onUnhandled,
      );
    }
  });
});

// ---------------------------------------------------------------------------
describe("RT-F3: responseCache capture eligibility (R4.10 contract)", () => {
  it("a bare hand-built string Response (no CT) is DECLINED — only framework snapshots capture", async () => {
    const app = new Keala(quiet);
    let calls = 0;
    app.get("/x", cache({ ttl: 60_000 }), () => {
      calls += 1;
      // No content-type and no framework snapshot identity: hand-built
      // bodies are never captured (a missing-CT byte body corrupted every
      // replay as U+FFFD before the R4.10 audit closed the surface).
      return new Response(`plain-${calls}`);
    });
    const first = await app.handle(req("/x"));
    expect(first.headers.get("x-cache")).toBeNull();
    const second = await app.handle(req("/x"));
    expect(second.headers.get("x-cache")).toBeNull();
    expect(await second.text()).toBe("plain-2");
    expect(calls).toBe(2);
  });

  it("the sugar equivalent (c.text, no explicit CT) still caches", async () => {
    const app = new Keala(quiet);
    let calls = 0;
    app.get("/s", cache({ ttl: 60_000 }), (c) => {
      calls += 1;
      return c.text(`sugar-${calls}`);
    });
    await app.handle(req("/s"));
    const second = await app.handle(req("/s"));
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(await second.text()).toBe("sugar-1");
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
describe("RT-F5: HEAD on committed responses never reads the body", () => {
  // R7-CORE-4: the finalizer performs NO body reads — small, huge and OPEN
  // committed bodies answer HEAD identically and promptly, carrying exactly
  // the headers the Response itself exposes (sugar HEAD returns attach CL at
  // construction; hand-built Responses carry only what their headers say).
  it("hand-built committed bodies carry no derived Content-Length", async () => {
    const app = new Keala(quiet);
    app.get("/small", () => new Response("hello world"));
    const res = await app.handle(new Request("http://localhost:3000/small", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.text()).toBe("");
  });

  it("an open committed stream answers HEAD promptly without blocking", async () => {
    const gate = new Promise<void>(() => {}); // never settles — no strand: we cancel
    const app = new Keala(quiet);
    app.get("/open", () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x61]));
        },
        pull() {
          void gate; // a slow producer: the second chunk never arrives
        },
      });
      return new Response(body);
    });
    const res = await app.handle(new Request("http://localhost:3000/open", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("RT-F6: pooling and websockets refuse to combine", () => {
  it("app.ws() on a pooled app throws loudly", () => {
    const app = new Keala({ ...quiet, pooling: true });
    expect(() => app.ws("/chat", { open: () => undefined })).toThrow(/pooling: true/);
  });
});

// ---------------------------------------------------------------------------
describe("RT-F7: c.append validates header names; the record is prototype-less", () => {
  it("append rejects forbidden/inherited names", () => {
    const app = new Keala(quiet);
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
    const app = new Keala(quiet);
    app.get("/b", (c) => {
      c.setHeader("X-Ok", "1");
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
    const app = new Keala(quiet);
    app.get("/u", cache({ ttl: 60_000 }), (c) => c.text("héllo"));
    await app.handle(req("/u")); // seed
    const head = await app.handle(new Request("http://localhost:3000/u", { method: "HEAD" }));
    expect(head.headers.get("x-cache")).toBe("hit");
    expect(head.headers.get("content-length")).toBe("6"); // é = 2 bytes
  });
});

// ---------------------------------------------------------------------------
describe("RT-F9: etag honors If-None-Match: *", () => {
  it("* matches any representation with 304", async () => {
    const app = new Keala(quiet);
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
    const app = new Keala(quiet);
    app.get("/r", (c) => {
      c.redirect("/café/😀");
    });
    const res = await app.handle(req("/r"));
    expect(res.headers.get("location")).toBe("/caf%C3%A9/%F0%9F%98%80");
  });

  it("existing percent-escapes and safe ASCII pass through untouched", async () => {
    const app = new Keala(quiet);
    app.get("/r2", (c) => {
      c.redirect("/a%20b?q=1&x=/y");
    });
    const res = await app.handle(req("/r2"));
    expect(res.headers.get("location")).toBe("/a%20b?q=1&x=/y");
  });

  it("re-homed from the retired koa differential (U1): escape edge cases", async () => {
    // A '%' not followed by two hex digits is not a valid escape and is
    // %25-encoded; spaces become %20; braces are encoded; apostrophes stay
    // raw; URL sub-delims and :@?#\[\] pass through.
    const app = new Keala(quiet);
    app.get("/e1", (c) => c.redirect("/trailing%"));
    app.get("/e2", (c) => c.redirect("/%zz invalid"));
    app.get("/e3", (c) => c.redirect("/a'apos"));
    app.get("/e4", (c) => c.redirect("/{brace}"));
    app.get("/e5", (c) => c.redirect("/a!$&()*+,;:@~[]?#=q"));
    expect((await app.handle(req("/e1"))).headers.get("location")).toBe("/trailing%25");
    expect((await app.handle(req("/e2"))).headers.get("location")).toBe("/%25zz%20invalid");
    expect((await app.handle(req("/e3"))).headers.get("location")).toBe("/a'apos");
    expect((await app.handle(req("/e4"))).headers.get("location")).toBe("/%7Bbrace%7D");
    expect((await app.handle(req("/e5"))).headers.get("location")).toBe("/a!$&()*+,;:@~[]?#=q");
  });
});
