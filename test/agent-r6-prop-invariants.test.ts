/**
 * ROUND 6 property audit — split of the original agent-r6-prop
 * file (500-line budget). Rig: agent-r6-prop-rig.ts / -ops.ts.
 */

import { describe, expect, it } from "vitest";
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
import { Keala } from "../src/index.ts";
import type { RouteHandler } from "../src/router/router.ts";

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
      const { Router } = await import("../src/router/group.ts");
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
