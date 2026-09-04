import { describe, expect, it } from "vitest";

// globalThis.Bun is non-writable AND non-configurable on the real Bun
// runtime — these suites stub it, so they run on the Node gate only (the
// real-runtime equivalents live in scripts/smoke.ts).
const REAL_BUN = typeof Bun !== "undefined";

import { Keala } from "../src/index.ts";

describe("branch coverage: final round", () => {
  it("catches synchronous middleware throws without a promise", async () => {
    const app = new Keala({ env: "test" });
    app.use(() => {
      throw new Error("sync boom");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
  });

  it.skipIf(REAL_BUN)("listen('3000', 'localhost') parses string port and hostname", () => {
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    let captured: Record<string, unknown> = {};
    (globalThis as { Bun?: unknown }).Bun = {
      serve: (options: Record<string, unknown>) => {
        captured = options;
        return {
          port: options["port"],
          hostname: "x",
          stop() {},
          fetch: async () => new Response(),
          reload() {},
        };
      },
    };
    try {
      new Keala().listen("3007", "localhost");
      expect(captured["port"]).toBe(3007);
      expect(captured["hostname"]).toBe("localhost");
    } finally {
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  // CONFIRMED-BUG (core): the HEAD Content-Length backfill writes into a
  // FRESHLY created header record while fromState keeps consulting the stale
  // (null) local `record`, so the bare fast path builds `new Response(null)`
  // and the backfilled "4" never reaches the wire — unless the request had
  // already produced some other header. Same root cause as the HEAD lock in
  // test/response.test.ts ("drops the body for HEAD requests").
  // Expected (koa): HEAD of a 4-byte binary body answers with
  // Content-Length "4".
  it("CONFIRMED-BUG: keeps Content-Length for HEAD with binary bodies", async () => {
    const app = new Keala();
    app.use(async (c) => {
      c.body = new Uint8Array([1, 2, 3, 4]);
    });
    const res = await app.handle(new Request("http://localhost:3000/", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("4");
  });

  it("combines a 201 status with multi-value Set-Cookie headers", async () => {
    // 0.7: the c.message statusText half of the old lock is gone with the API.
    const app = new Keala();
    app.use(async (c) => {
      c.status = 201;
      c.append("Set-Cookie", ["a=1; Path=/", "b=2; Path=/"]);
      c.body = "created";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(201);
    expect([...res.headers.getSetCookie()]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("exposes computed length for binary and empty bodies", async () => {
    const app = new Keala();
    let binaryLength: number | undefined = -1;
    let streamLength: number | undefined = -1;
    app.use(async (c, next) => {
      c.body = new Uint8Array([9, 9, 9]);
      binaryLength = c.length;
      await next();
    });
    app.use(async (c) => {
      c.body = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      streamLength = c.length;
    });
    await app.handle(new Request("http://localhost:3000/"));
    expect(binaryLength).toBe(3);
    expect(streamLength).toBeUndefined(); // streams have no known length (koa)
  });

  // 0.7 deletions: the argless acceptsCharsets/acceptsLanguages context
  // methods and the c.fresh freshness locks are gone with the APIs (parse
  // the Accept-* headers yourself; conditional.ts owns freshness).
});
