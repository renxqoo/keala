/**
 * ROUND 6 property audit — split of the original agent-r6-prop
 * file (500-line budget). Rig: agent-r6-prop-rig.ts / -ops.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  UNICODE,
  quiet,
  randPath,
  randQueryString,
  randString,
  tryRequest,
} from "./agent-r6-prop-rig.mts";
import { randErrorInstance, runProp, scanWire } from "./agent-r6-prop-ops.mts";
import { EMPTY_CFG, committer, lateMutations, makeCfgHandler } from "./agent-r6-prop-inv7.mts";
import type { RespCfg } from "./agent-r6-prop-inv7.mts";
import { createApp } from "../src/index.ts";

describe("INV-7 response consistency", () => {
  it("HEAD => null body + GET-equal status; 204/205/304 => no body, no content-* headers", async () => {
    await runProp("head-empty-status", 200, async (rng) => {
      const cfg: RespCfg = {
        style: rng.pick(["state", "sugar", "committed"] as const),
        status: rng.pick([200, 201, 204, 205, 301, 302, 304, 418] as const),
        body: rng.pick(["text", "json", "bytes", "redirect"] as const),
      };
      const app = createApp({ ...quiet });
      app.get("/r", makeCfgHandler(cfg));
      const getRes = await app.handle(new Request("http://localhost/r"));
      const getBody = getRes.body === null ? "" : await getRes.text();
      const headRes = await app.handle(new Request("http://localhost/r", { method: "HEAD" }));
      if (headRes.body !== null) {
        throw new Error(`HEAD body not null (style=${cfg.style}, status=${cfg.status})`);
      }
      if (headRes.status !== getRes.status) {
        throw new Error(`HEAD status ${headRes.status} != GET ${getRes.status}`);
      }
      const hcl = headRes.headers.get("content-length");
      const gcl = getRes.headers.get("content-length");
      if (hcl !== null && gcl !== null && hcl !== gcl) {
        throw new Error(`HEAD content-length ${hcl} != GET ${gcl}`);
      }
      // Redirect bodies legitimately override an empty cfg status to 302
      // (koa parity) — emptiness is judged on the ACTUAL shipped status.
      if (EMPTY_CFG.has(getRes.status)) {
        if (getRes.body !== null) throw new Error(`${getRes.status} GET carries a body`);
        for (const h of ["content-type", "content-length", "transfer-encoding"]) {
          if (getRes.headers.get(h) !== null) throw new Error(`${getRes.status} GET has ${h}`);
          if (headRes.headers.get(h) !== null) throw new Error(`${getRes.status} HEAD has ${h}`);
        }
      }
      if (
        cfg.body === "redirect" &&
        cfg.status !== 204 &&
        cfg.status !== 205 &&
        cfg.status !== 304
      ) {
        const hl = headRes.headers.get("location");
        const gl = getRes.headers.get("location");
        if (hl !== null && gl !== null && hl !== gl) {
          throw new Error(`HEAD location ${hl} != GET ${gl}`);
        }
      }
      void getBody;
    });
  }, 20_000);

  it("HEAD on committed responses with post-commit mutations keeps a null body and sane status", async () => {
    await runProp("head-dirty-committed", 200, async (rng) => {
      const app = createApp({ ...quiet, pooling: rng.bool(0.3) });
      const mutate = lateMutations(rng);
      const style = rng.pick(["text", "json", "response", "stream"] as const);
      const ops: string[] = [];
      const observed: string[] = [];
      app.onError((err) => {
        observed.push(`${err.name}: ${err.message}`);
      });
      app.use(async (c, next) => {
        await next();
        try {
          mutate(c, ops);
        } catch {
          /* invalid mutations become 500s — fine, never-reject covers those */
        }
      });
      app.get("/r", committer(rng, style));
      const headRes = await app.handle(new Request("http://localhost/r", { method: "HEAD" }));
      expect(headRes).toBeInstanceOf(Response);
      if (headRes.body !== null) {
        throw new Error(
          `HEAD on dirty committed (${style}) has a body; ops=[${ops.join(",")}] status=${headRes.status} ` +
            `onerror=[${observed.join(" | ")}] headers=${JSON.stringify(Object.fromEntries(headRes.headers.entries()))}`,
        );
      }
      const getRes = await app.handle(new Request("http://localhost/r"));
      expect(getRes).toBeInstanceOf(Response);
      if (EMPTY_CFG.has(getRes.status) && getRes.body !== null) {
        throw new Error(`${getRes.status} carries a body after mutations`);
      }
      scanWire(headRes, "head-dirty");
      scanWire(getRes, "get-dirty");
      await getRes.arrayBuffer().catch(() => undefined);
    });
  }, 20_000);
});
describe("INV-8 error-path completeness", () => {
  it("random thrown error => status in [400,599], readable body, wire-safe headers, onerror exactly once", async () => {
    await runProp("error-path", 250, async (rng, _seed, ctx) => {
      const app = createApp({ ...quiet });
      let onerr = 0;
      app.onError(() => {
        onerr++;
      });
      const err = randErrorInstance(rng);
      const fromMiddleware = rng.bool(0.4);
      // 25%: the chain stages a NON-latin-1 header before failing — the error
      // path must still answer with exactly one onerror (see red test R6-1).
      // The trailing 中 guarantees a code unit > 0xFF (a bare é is latin-1).
      const stageUnicode = rng.bool(0.25);
      if (fromMiddleware) {
        app.use((c) => {
          if (stageUnicode) c.set("x-unicode", `café${randString(rng, 4, UNICODE)}中`);
          throw err;
        });
        app.get("/e", (c) => c.text("never"));
      } else {
        app.use((c, next) => {
          if (stageUnicode) c.set("x-unicode", `café${randString(rng, 4, UNICODE)}中`);
          return next();
        });
        app.get("/e", () => {
          throw err;
        });
      }
      const req = tryRequest(rng, "http://localhost/e", false);
      if (req === null) {
        ctx.skipped++;
        return;
      }
      const res = await app.handle(req);
      expect(res).toBeInstanceOf(Response);
      if (res.status < 400 || res.status > 599) {
        throw new Error(`error status ${res.status} out of [400,599]`);
      }
      const text = await res.text();
      if (typeof text !== "string") throw new Error("error body not a string");
      scanWire(res, "error-path");
      if (onerr !== 1) {
        throw new Error(`app.onerror called ${onerr}x (stageUnicode=${stageUnicode})`);
      }
    });
  }, 20_000);
});
// Shared unhandled-rejection collector (reconstructed after the file split):
// INV-9/INV-1/INV-4 bodies assert nothing escapes the framework.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeAll(() => {
  (process.on as unknown as (event: string, fn: (reason: unknown) => void) => void)(
    "unhandledRejection",
    onUnhandled,
  );
});
afterAll(() => {
  (process.off as unknown as (event: string, fn: (reason: unknown) => void) => void)(
    "unhandledRejection",
    onUnhandled,
  );
});

describe("INV-9 stream safety", () => {
  beforeAll(() => {
    process.on("unhandledRejection", onUnhandled);
  });
  afterAll(() => {
    (process.off as unknown as (event: string, fn: (reason: unknown) => void) => void)(
      "unhandledRejection",
      onUnhandled,
    );
  });

  it("random chunk sequences x random consumption leave no unhandledRejection; follow-ups work", async () => {
    await runProp("stream-safety", 60, async (rng) => {
      const streamErrors: unknown[] = [];
      const app = createApp({
        ...quiet,
        pooling: rng.bool(0.5),
        onStreamError: (e) => {
          streamErrors.push(e);
        },
      });
      const errorAt = rng.bool(0.4) ? rng.range(0, 3) : -1;
      const closeEarly = errorAt === -1 && rng.bool(0.2);
      app.get("/s", () => {
        let i = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (i === errorAt) {
                controller.error(new Error(`producer boom at ${i}`));
                return;
              }
              if (closeEarly && i >= 1) {
                controller.close();
                return;
              }
              controller.enqueue(new TextEncoder().encode(`chunk-${i++};`));
              if (i > 4) controller.close();
            },
          }),
          { headers: { "content-type": "text/plain" } },
        );
      });
      app.get("/after", (c) => c.text("still-alive"));
      const res = await app.handle(new Request("http://localhost/s"));
      const mode = rng.int(3);
      try {
        if (mode === 0) await res.text();
        else if (mode === 1) {
          const reader = res.body?.getReader();
          if (reader !== undefined) {
            await reader.read();
            await reader.cancel();
          }
        }
        // mode 2: never touch the body
      } catch {
        /* consumer-visible stream errors are expected */
      }
      const after = await app.handle(new Request("http://localhost/after"));
      expect(after.status).toBe(200);
      expect(await after.text()).toBe("still-alive");
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(unhandled).toEqual([]);
    unhandled.length = 0;
  }, 30_000);
});
describe("INV-10 compose double next", () => {
  it("double next() at a random position answers 500 (uncaught) / runs downstream once (caught)", async () => {
    await runProp("double-next", 150, async (rng) => {
      let innerRuns = 0;
      const app = createApp({ ...quiet });
      const pos = rng.range(0, 3);
      const caught = rng.bool(0.3);
      for (let i = 0; i < 4; i++) {
        if (i !== pos) {
          app.use(async (_c, next) => {
            await next();
          });
          continue;
        }
        if (caught) {
          app.use((c, next) => {
            // First call: may settle synchronously (sync chains return void).
            const first = next();
            if (first !== undefined) void first.catch(() => undefined);
            try {
              void next(); // second call must throw; the handler swallows it
            } catch {
              /* swallowed by the handler itself */
            }
            return c.text("caught");
          });
        } else if (rng.bool(0.5)) {
          app.use((_c, next) => {
            void next();
            return next(); // second call throws synchronously
          });
        } else {
          app.use(async (_c, next) => {
            await next();
            await next(); // second call rejects the handler promise
          });
        }
      }
      app.get("/d", (c) => {
        innerRuns++;
        return c.text("done");
      });
      const res = await app.handle(new Request("http://localhost/d"));
      expect(res).toBeInstanceOf(Response);
      if (caught) {
        if (innerRuns > 1) throw new Error(`route handler ran ${innerRuns}x after double next`);
        if (res.status >= 500) throw new Error(`caught variant answered ${res.status}`);
      } else {
        if (innerRuns > 1) throw new Error(`route handler ran ${innerRuns}x after double next`);
        if (res.status !== 500) {
          throw new Error(`uncaught double next answered ${res.status}, expected 500`);
        }
      }
    });
  }, 20_000);
});
describe("INV-11 URL semantics", () => {
  it("random URL shapes keep c.path rooted and path+search === url === originalUrl", async () => {
    await runProp("url-semantics", 300, async (rng, _seed, ctx) => {
      interface UrlProbe {
        path: string;
        qs: string;
        search: string;
        url: string;
        orig: string;
        queryProto: unknown;
      }
      let captured: UrlProbe | null = null;
      const app = createApp({ ...quiet });
      app.on("ALL", "/*", (c) => {
        captured = {
          path: c.path,
          qs: c.querystring,
          search: c.search,
          url: c.url,
          orig: c.originalUrl,
          queryProto: Object.getPrototypeOf(c.query),
        };
        return c.text("ok");
      });
      const raw = `http://localhost${randPath(rng)}${
        rng.bool(0.7) ? `?${randQueryString(rng)}` : ""
      }`;
      let req: Request;
      try {
        req = new Request(raw);
      } catch {
        ctx.skipped++;
        return;
      }
      const res = await app.handle(req);
      expect(res).toBeInstanceOf(Response);
      await res.text();
      const p = captured as unknown as UrlProbe; // assigned in a handler closure
      if (p === null) throw new Error("handler never ran");
      if (typeof p.path !== "string" || !p.path.startsWith("/")) {
        throw new Error(`path not rooted: ${JSON.stringify(p.path)}`);
      }
      const expectedSearch = p.qs === "" ? "" : `?${p.qs}`;
      if (p.search !== expectedSearch) {
        throw new Error(`search ${JSON.stringify(p.search)} != ${JSON.stringify(expectedSearch)}`);
      }
      // path+search === url, with koa's documented exception: a URL ending in
      // a bare "?" keeps the "?" in url while search collapses to "".
      if (p.path + p.search !== p.url && !(p.qs === "" && p.url === `${p.path}?`)) {
        throw new Error(
          `path+search ${JSON.stringify(p.path + p.search)} != url ${JSON.stringify(p.url)}`,
        );
      }
      if (p.url !== p.orig) throw new Error(`url ${p.url} != originalUrl ${p.orig}`);
      if (p.queryProto !== null) throw new Error("c.query is not null-proto");
    });
  }, 20_000);
});
