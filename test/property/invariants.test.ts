import { describe, expect, it } from "vitest";

import { Keala } from "../../src/index.ts";
import {
  PRINTABLE,
  delay,
  quiet,
  randCookieHeader,
  randPath,
  randQueryString,
  randString,
  tryRequest,
} from "./agent-r6-prop-rig.mts";
import {
  randHandler,
  randRoutePath,
  runProp,
  scanWire,
  wellBehavedMiddleware,
} from "./agent-r6-prop-ops.mts";
import { commitStyles, committer, lateMutations } from "./agent-r6-prop-inv7.mts";
import type { RouteHandler } from "../../src/router/router.ts";
/**
 * ROUND 6 property audit — split of the original agent-r6-prop
 * file (500-line budget). Rig: agent-r6-prop-rig.ts / -ops.ts.
 */

describe("agent-r6 RED: confirmed violations", () => {
  it("R6-1 [INV-8, seed head-dirty-committed#17] non-latin-1 header value must not flood app.onerror", async () => {
    // Minimal repro of the property failure at seed 17 (ops [set,type,message,
    // body]): a header VALUE that passes c.setHeader() validation (only CR/LF/NUL
    // are rejected by validateHeaderValue, src/utils/text.ts:63) but is not a
    // ByteString (code unit > 0xFF) throws in the fetch Headers constructor
    // at finalize. buildErrorResponse (src/core/dispatch.ts:261-266) keeps the
    // offending staged header in c.headersRecord (only content-* headers are
    // dropped), so the rebuilt error response throws AGAIN, re-entering
    // errorResponse -> buildErrorResponse -> finalizeGuarded in an unbounded
    // mutual recursion that only stops at stack overflow (~1.3k frames), each
    // level firing app.onerror once. In production (env != test, no listener)
    // every level also console.error's the full stack — a log-flood amplifier
    // reachable with a single request. Correct contract: onerror fires once.
    const app = new Keala({ ...quiet });
    let onerror = 0;
    app.onError(() => {
      onerror++;
    });
    app.get("/r", (c) => {
      c.setHeader("x-unicode", "café中"); // 0xE9 and 0x4E2D — not a ByteString
      return c.text("ok");
    });
    const res = await app.handle(new Request("http://localhost/r"));
    expect(res.status).toBe(500);
    expect(onerror).toBe(1); // RED: fires ~1354x today
  }, 10_000);

  it("R6-2 [INV-7, seed head-dirty-committed#148] a HEAD response must never carry a body", async () => {
    // The last-resort staticServerError() (src/core/dispatch.ts:240-244) is
    // `new Response("Internal Server Error", …)` — it ignores the request
    // method, so a HEAD request whose finalize failed answers with a BODIED
    // 500. RFC 9110 §9.3.2: a server MAY send headers for HEAD as if GET,
    // but MUST NOT send a body — a bodied HEAD desyncs any keep-alive
    // connection (the client reads the body bytes as the next response).
    const app = new Keala({ ...quiet });
    app.get("/r", (c) => {
      c.setHeader("x-unicode", "café中");
      return c.text("ok");
    });
    const res = await app.handle(new Request("http://localhost/r", { method: "HEAD" }));
    expect(res.status).toBe(500);
    expect(res.body).toBe(null); // RED: "Internal Server Error" today
  }, 10_000);

  it("R6-3 [INV-7+INV-8, seed head-dirty-committed#17/35/140/148] post-commit mutation with a non-latin-1 value", async () => {
    // The exact fuzz shape from the property: a committed json response whose
    // outer middleware stages a unicode header (plus benign late writes)
    // after next(). rebuildCommitted's headers.set() throws, the
    // error path re-stages the poison header, and the recursion above runs —
    // onerror floods and the HEAD answer is bodied.
    const app = new Keala({ ...quiet });
    let onerror = 0;
    app.onError(() => {
      onerror++;
    });
    app.use(async (c, next) => {
      await next();
      // U3c: the seed's type/body ops are gone with the setters — the
      // post-commit header write alone carries the mutation class (it now
      // lands directly on the committed Response's Headers, §0.7 contract).
      c.setHeader("x-unicode", "café中"); // the poison write (seed 17's `set` op)
    });
    app.get("/r", (c) => c.json({ a: 1 }, 200));
    const res = await app.handle(new Request("http://localhost/r", { method: "HEAD" }));
    expect(res).toBeInstanceOf(Response);
    expect(res.body).toBe(null); // RED: bodied 500 today
    expect(onerror).toBe(1); // RED: ~1357 fires today
  }, 10_000);

  it("R6-4 [INV-1/INV-9] the error-path recursion must not leak unhandled rejections", async () => {
    // Same poison as R6-1, thrown from a MIDDLEWARE. Whether the stack
    // overflow lands inside errorResponse's protected try/catch or inside the
    // bare `out.catch(() => staticServerError())` arrow (dispatch.ts:232)
    // depends on the caller's stack depth — for callers at the wrong depth
    // (this test's shape) the RangeError escapes the framework entirely as
    // an UNHANDLED promise rejection. Under a real server an unhandled
    // rejection can take the worker down; the never-reject contract on
    // app.handle must extend to everything it kicks off.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    (process.on as unknown as (event: string, fn: (reason: unknown) => void) => void)(
      "unhandledRejection",
      onUnhandledRejection,
    );
    const app = new Keala({ ...quiet });
    let onerror = 0;
    app.onError(() => {
      onerror++;
    });
    app.use((c) => {
      c.setHeader("x-unicode", "café中");
      throw new Error("handler boom");
    });
    app.get("/e", (c) => c.text("never"));
    const res = await app.handle(new Request("http://localhost/e"));
    const body = await res.text(); // RED today: unhandled RangeError escapes here
    (process.off as unknown as (event: string, fn: (reason: unknown) => void) => void)(
      "unhandledRejection",
      onUnhandledRejection,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(res.status).toBe(500);
    expect(body).toBe("Internal Server Error");
    expect(onerror).toBe(1);
    expect(unhandled).toEqual([]); // RED: escaped RangeError(s) today
  }, 10_000);
});

/**
 * ROUND 6 property audit — split of the original agent-r6-prop
 * file (500-line budget). Rig: agent-r6-prop-rig.ts / -ops.ts.
 */

describe("INV-1 never-reject", () => {
  it("any middleware/handler behavior x any request => Response, no sync throw, no rejection", async () => {
    await runProp("never-reject", 300, async (rng, _seed, ctx) => {
      const app = new Keala({ ...quiet });
      const n = rng.range(0, 3);
      for (let i = 0; i < n; i++) app.use(randHandler(rng, { mode: "any" }));
      const nr = rng.range(1, 4);
      for (let i = 0; i < nr; i++) {
        app.on(
          rng.pick(["GET", "POST", "ALL", "PUT"] as const),
          randRoutePath(rng),
          randHandler(rng, { mode: "any" }),
        );
      }
      app.on("ALL", "/*", randHandler(rng, { mode: "any" }));
      const url = `http://localhost${randPath(rng)}${
        rng.bool(0.7) ? `?${randQueryString(rng)}` : ""
      }`;
      const req = tryRequest(rng, url, rng.bool(0.3));
      if (req === null) {
        ctx.skipped++;
        return;
      }
      let out: Response | Promise<Response>;
      try {
        out = app.handle(req);
      } catch (err) {
        throw new Error(`sync throw out of app.handle: ${String(err).slice(0, 200)}`, {
          cause: err,
        });
      }
      const res = out instanceof Promise ? await out : out;
      expect(res).toBeInstanceOf(Response);
      expect(Number.isInteger(res.status)).toBe(true);
    });
  }, 20_000);

  it("pooling variant: same contract under pooling:true", async () => {
    await runProp("never-reject(pooled)", 150, async (rng, _seed, ctx) => {
      const app = new Keala({ ...quiet, pooling: true });
      app.use(randHandler(rng, { mode: "any" }));
      app.on("ALL", "/*", randHandler(rng, { mode: "any" }));
      const req = tryRequest(rng, `http://localhost${randPath(rng)}`, rng.bool(0.3));
      if (req === null) {
        ctx.skipped++;
        return;
      }
      const res = await app.handle(req);
      expect(res).toBeInstanceOf(Response);
      // drain so the pooled context retires
      try {
        await res.arrayBuffer();
      } catch {
        /* unreadable bodies are a handler bug, not a handle() contract break */
      }
    });
  }, 20_000);

  it("committed responses + random post-commit mutations still never reject and stay wire-safe", async () => {
    await runProp("post-commit-mutations", 300, async (rng, _seed, ctx) => {
      const app = new Keala({ ...quiet, pooling: rng.bool(0.4), keys: ["r6-secret"] });
      const mutate = lateMutations(rng);
      const style = rng.pick(commitStyles);
      const wait = rng.bool(0.4);
      app.use(async (c, next) => {
        if (wait) await delay(rng.int(2));
        await next();
        mutate(c);
      });
      app.get("/r", committer(rng, style));
      const method = rng.bool(0.2) ? "POST" : "GET";
      const req = tryRequest(rng, "http://localhost/r", method === "POST");
      if (req === null) {
        ctx.skipped++;
        return;
      }
      const res = await app.handle(req);
      expect(res).toBeInstanceOf(Response);
      scanWire(res, `post-commit (${style})`);
      if (rng.bool(0.5)) {
        try {
          await res.arrayBuffer();
        } catch {
          /* stream errors may surface at the consumer */
        }
      }
    });
  }, 25_000);

  // 0.7: the "random c.url/c.path/c.query/... rewrites" property is gone —
  // request setters were deleted (requests are read-only).
});
describe("INV-2 exactly-once", () => {
  it("counter at a random position among well-behaved middleware runs exactly once", async () => {
    await runProp("exactly-once", 200, async (rng, _seed, ctx) => {
      const app = new Keala({ ...quiet });
      let count = 0;
      const counter: RouteHandler = (_c, next) => {
        count++;
        return next();
      };
      const mws: RouteHandler[] = [];
      const n = rng.range(1, 4);
      for (let i = 0; i < n; i++) mws.push(wellBehavedMiddleware(rng));
      mws.splice(rng.int(mws.length + 1), 0, counter);
      for (const mw of mws) app.use(mw);
      // Random route table incl. duplicate registrations.
      const nr = rng.range(1, 5);
      for (let i = 0; i < nr; i++) {
        app.on(
          rng.pick(["GET", "POST", "ALL", "HEAD"] as const),
          randRoutePath(rng),
          randHandler(rng, { mode: "any" }),
        );
      }
      // 30%: late middleware after routes (triggers rebuildChains).
      if (rng.bool(0.3)) app.use(wellBehavedMiddleware(rng));
      if (rng.bool(0.2)) app.param("id", wellBehavedMiddleware(rng));

      const urls = [
        `http://localhost${randPath(rng)}`,
        rng.pick([
          "http://localhost/definitely-not-registered",
          "http://localhost/users/42",
          "http://localhost/a/b",
          "http://localhost/files/x/y",
        ]),
      ];
      for (const url of urls) {
        const req = tryRequest(rng, url, rng.bool(0.2));
        if (req === null) {
          ctx.skipped++;
          continue;
        }
        count = 0;
        const res = await app.handle(req);
        expect(res).toBeInstanceOf(Response);
        try {
          await res.arrayBuffer();
        } catch {
          /* ignore */
        }
        if (count !== 1) throw new Error(`global middleware ran ${count}x for ${req.url}`);
      }
    });
  }, 25_000);

  it("arbitrary (misbehaving) siblings never push the count past 1", async () => {
    await runProp("at-most-once", 200, async (rng, _seed, ctx) => {
      const app = new Keala({ ...quiet });
      let count = 0;
      const counter: RouteHandler = (_c, next) => {
        count++;
        return next();
      };
      const n = rng.range(0, 3);
      for (let i = 0; i < n; i++) app.use(randHandler(rng, { mode: "any" }));
      app.use(counter);
      app.on("ALL", "/*", randHandler(rng, { mode: "any" }));
      const req = tryRequest(rng, `http://localhost${randPath(rng)}`, false);
      if (req === null) {
        ctx.skipped++;
        return;
      }
      count = 0;
      const res = await app.handle(req);
      expect(res).toBeInstanceOf(Response);
      if (count > 1) throw new Error(`global middleware ran ${count}x`);
    });
  }, 20_000);

  it("mount/sub-router/param layers each run exactly once per matching request", async () => {
    await runProp("mount-exactly-once", 200, async (rng) => {
      const { Router } = await import("../../src/router/group.ts");
      const app = new Keala({ ...quiet });
      const counts = { global: 0, sub: 0, param: 0, handler: 0 };
      app.use((_c, next) => {
        counts.global++;
        return next();
      });
      app.param("id", (_c, next) => {
        counts.param++;
        return next();
      });
      const sub = new Router();
      sub.use((_c, next) => {
        counts.sub++;
        return next();
      });
      sub.get("/detail/:id", (_c, next) => {
        counts.handler++;
        return next();
      });
      const prefixRaw = rng.pick(["/sub", "/sub/", ""]);
      const prefix = prefixRaw.replace(/\/+$/, "") || ""; // canonical mount base
      app.mount(prefixRaw, sub);
      // sometimes a duplicate registration on the SAME resulting path
      const dup = rng.bool(0.4);
      if (dup) app.get(`${prefix || ""}/detail/:id`, () => new Response("dup"));
      const res = await app.handle(new Request(`http://localhost${prefix || ""}/detail/7`));
      expect(res).toBeInstanceOf(Response);
      await res.arrayBuffer();
      // global middleware: exactly once no matter how many layers exist.
      if (counts.global !== 1) throw new Error(`global ran ${counts.global}x`);
      // sub-router use() middleware is baked as prefix middleware of the
      // mounted layer only — a duplicate layer must not re-run it.
      if (counts.sub !== 1) throw new Error(`sub middleware ran ${counts.sub}x`);
      // param middleware runs once per matching layer (@koa/router); the app's
      // own duplicate registration adds a second layer capturing :id.
      const paramExpected = 1 + (dup ? 1 : 0);
      if (counts.param !== paramExpected) {
        throw new Error(`param middleware ran ${counts.param}x, expected ${paramExpected}`);
      }
      // the sub-router's handler runs once (the duplicate layer's handler is
      // a different function and is not counted here).
      if (counts.handler !== 1) throw new Error(`handler ran ${counts.handler}x`);
    });
  }, 20_000);
});
describe("INV-3 wire-safety", () => {
  it("random header/cookie/redirect/statusText injection never reaches the wire", async () => {
    await runProp("wire-safety", 250, async (rng, _seed, ctx) => {
      const app = new Keala({ ...quiet, keys: ["r6-secret"] });
      app.use(randHandler(rng, { mode: "any" }));
      app.on("ALL", "/*", randHandler(rng, { mode: "any" }));
      const headers: Record<string, string> = {
        accept: rng.pick([
          "text/html",
          "application/json",
          "*/*",
          "text/html;q=0.9, application/json",
          "garbage,",
        ]),
        referer: rng.pick(["http://localhost/", "//evil.com", randString(rng, 20, PRINTABLE)]),
        cookie: randCookieHeader(rng),
      };
      const url = `http://localhost${randPath(rng)}?${randQueryString(rng)}`;
      let req: Request;
      try {
        req = new Request(url, { method: "GET", headers });
      } catch {
        ctx.skipped++;
        return;
      }
      const res = await app.handle(req);
      expect(res).toBeInstanceOf(Response);
      scanWire(res, `wire-safety (${req.url})`);
    });
  }, 20_000);
});
