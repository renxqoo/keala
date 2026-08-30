import { describe, expect, it } from "vitest";

// globalThis.Bun is non-writable AND non-configurable on the real Bun
// runtime — these suites stub it, so they run on the Node gate only (the
// real-runtime equivalents live in scripts/smoke.ts).
const REAL_BUN = typeof Bun !== "undefined";

import { createApp } from "../src/index.ts";
import type { Context } from "../src/core/context/context.ts";

const probe = async (url: string, headers: Record<string, string>): Promise<Context> => {
  const app = createApp();
  let captured: Context | undefined;
  app.use(async (c) => {
    captured = c;
    c.body = "probed";
  });
  await app.handle(new Request(url, { headers }));
  if (captured === undefined) throw new Error("probe did not run");
  return captured;
};

describe("branch coverage: final round", () => {
  it("catches synchronous middleware throws without a promise", async () => {
    const app = createApp({ env: "test" });
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
          fetch: () => new Response(),
          reload() {},
        };
      },
    };
    try {
      createApp().listen("3007", "localhost");
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
    const app = createApp();
    app.use(async (c) => {
      c.body = new Uint8Array([1, 2, 3, 4]);
    });
    const res = await app.handle(new Request("http://localhost:3000/", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("4");
  });

  it("combines custom status text with multi-value headers", async () => {
    const app = createApp();
    app.use(async (c) => {
      c.status = 201;
      c.message = "with cookies";
      c.append("Set-Cookie", ["a=1; Path=/", "b=2; Path=/"]);
      c.body = "created";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("with cookies");
    expect([...res.headers.getSetCookie()]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("exposes computed length for binary and empty bodies", async () => {
    const app = createApp();
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

  it("argless acceptsCharsets/Languages through the context", async () => {
    const ctx = await probe("http://localhost:3000/", {
      "Accept-Charset": "utf-8, ascii;q=0.5",
      "Accept-Language": "fr-CA, fr;q=0.8",
    });
    expect(ctx.acceptsCharsets()).toEqual(["utf-8", "ascii"]);
    expect(ctx.acceptsLanguages()).toEqual(["fr-ca", "fr"]);
    const bare = await probe("http://localhost:3000/", {});
    expect(bare.acceptsCharsets()).toEqual([]);
    expect(bare.acceptsLanguages()).toEqual([]);
  });

  it("falls back to last-modified when etag lacks if-none-match", async () => {
    const app = createApp();
    let freshWithEtag: boolean | undefined;
    app.use(async (c) => {
      c.status = 200;
      c.etag = "v1";
      c.lastModified = new Date(Date.UTC(2024, 0, 1));
      freshWithEtag = c.fresh;
      c.body = "x";
    });
    await app.handle(
      new Request("http://localhost:3000/", {
        headers: { "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT" },
      }),
    );
    expect(freshWithEtag).toBe(true);
  });

  it("matches any etag against If-None-Match: *", async () => {
    const app = createApp();
    let freshStar: boolean | undefined;
    app.use(async (c) => {
      c.status = 200;
      c.etag = "anything";
      freshStar = c.fresh;
      c.body = "x";
    });
    await app.handle(new Request("http://localhost:3000/", { headers: { "If-None-Match": "*" } }));
    expect(freshStar).toBe(true);
  });

  it("is stale when only if-none-match is absent and lastModified is unset", async () => {
    const app = createApp();
    let freshNoValidators: boolean | undefined;
    app.use(async (c) => {
      c.status = 200;
      c.etag = "v1";
      freshNoValidators = c.fresh;
      c.body = "x";
    });
    await app.handle(
      new Request("http://localhost:3000/", {
        headers: { "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT" },
      }),
    );
    expect(freshNoValidators).toBe(false);
  });
});
