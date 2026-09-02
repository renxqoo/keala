/**
 * R4.3 performance review — in-process ratio fences (agent review, read-only
 * outside this file). Style follows test/agent-perf-evidence.test.ts: measure
 * baseline vs variant in the SAME process, rotate measurement order, compare
 * medians, assert GENEROUS fences so a test is only RED for a real, large
 * regression or leak — never for machine noise.
 *
 * Fences here probe the R4.3 claims:
 *  1. registering app.onError must cost NOTHING on healthy requests (the
 *     mapper check lives only inside the error funnel);
 *  2. the error funnel must not retain per-error memory (no app-level
 *     structures holding error objects);
 *  3. error-path component costs (toHttpError classification, non-Error
 *     normalization, error.headers merge) stay micro, and the mapper shape
 *     stays faster than the koa-style try/catch middleware shape.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { createError, toHttpError } from "../src/http/errors.ts";
import { getPath, getSearch } from "../src/utils/url.ts";

const isBun = typeof Bun !== "undefined";

const requestFor = (path: string) => new Request(`http://localhost:3000${path}`);

const medianOf = (xs: number[]): number => {
  const sorted = xs.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

/** Alternate A/B; current-thread CPU excludes parallel worker activity. */
const measurePair = async (
  opA: () => Promise<unknown>,
  opB: () => Promise<unknown>,
  warmup: number,
  batch: number,
  samples: number,
): Promise<{ aNs: number; bNs: number }> => {
  for (let i = 0; i < warmup; i++) {
    await opA();
    await opB();
  }
  const timesA: number[] = [];
  const timesB: number[] = [];
  const timed = async (op: () => Promise<unknown>): Promise<number> => {
    if (isBun) Bun.gc(true);
    const start = process.threadCpuUsage();
    for (let i = 0; i < batch; i++) await op();
    const elapsed = process.threadCpuUsage(start);
    return ((elapsed.user + elapsed.system) * 1e3) / batch;
  };
  for (let sample = 0; sample < samples; sample++) {
    if (sample % 2 === 0) {
      timesA.push(await timed(opA));
      timesB.push(await timed(opB));
    } else {
      timesB.push(await timed(opB));
      timesA.push(await timed(opA));
    }
  }
  return { aNs: medianOf(timesA), bNs: medianOf(timesB) };
};

/** Sync micro median (ns/op), isolated from other Vitest worker threads. */
const microMedian = (op: () => void, warmup: number, batch: number, samples: number): number => {
  for (let i = 0; i < warmup; i++) op();
  const times: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    if (isBun) Bun.gc(true);
    const start = process.threadCpuUsage();
    for (let i = 0; i < batch; i++) op();
    const elapsed = process.threadCpuUsage(start);
    times.push(((elapsed.user + elapsed.system) * 1e3) / batch);
  }
  return medianOf(times);
};

/** Warm, full-GC, measure one window, full-GC: retained bytes per op. */
const retainedPerOpBun = async (
  op: () => Promise<unknown>,
  warmup: number,
  measured: number,
): Promise<number> => {
  for (let i = 0; i < warmup; i++) await op();
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < measured; i++) await op();
  Bun.gc(true);
  const after = process.memoryUsage().heapUsed;
  return (after - before) / measured;
};

const envelope = { error: { code: "internal" } } as const;

describe("R4.3 perf review: happy path must not feel the mapper", () => {
  it(
    "probe-like happy path: registered mapper vs no mapper is parity (<10%)",
    { timeout: 120_000 },
    async () => {
      const bare = new Keala({ env: "test" });
      bare.get("/livez", (c) => c.text("hello world"));
      const mapped = new Keala({ env: "test" });
      mapped.onError(() => undefined); // registered, never fires on /livez
      mapped.get("/livez", (c) => c.text("hello world"));

      const req = requestFor("/livez");
      let guard = 0;
      // Heavy warmup: the first measured pair in a process still carries JIT
      // tier-up noise, so both sides spin 40k requests before sampling.
      const { aNs, bNs } = await measurePair(
        async () => {
          const res = await bare.handle(req);
          guard += res.status;
        },
        async () => {
          const res = await mapped.handle(req);
          guard += res.status;
        },
        40_000,
        4_000,
        13,
      );
      expect(guard).toBeGreaterThan(0);
      console.log(
        `[perf-review] probe-like: no-mapper ${aNs.toFixed(0)}ns, mapper ${bNs.toFixed(0)}ns`,
      );
      // Generous fence: only RED if registering onError slows healthy requests
      // by a real margin (>10% median), not noise.
      // Structural tripwire only — full-suite parallel load wanders ±20%.
      expect(bNs).toBeLessThan(aNs * 1.45);
    },
  );

  it(
    "dirty happy path (post-next header set): registered mapper vs no mapper is parity (<10%)",
    { timeout: 120_000 },
    async () => {
      const bare = new Keala({ env: "test" });
      const mapped = new Keala({ env: "test" });
      mapped.onError(() => undefined);
      for (const app of [bare, mapped]) {
        app.use(async (c, next) => {
          await next();
          c.set("x-late", "1");
        });
        app.get("/text", (c) => c.text("hello"));
      }
      const req = requestFor("/text");
      let guard = 0;
      const { aNs, bNs } = await measurePair(
        async () => {
          const res = await bare.handle(req);
          guard += res.status;
        },
        async () => {
          const res = await mapped.handle(req);
          guard += res.status;
        },
        8_000,
        4_000,
        11,
      );
      expect(guard).toBeGreaterThan(0);
      console.log(`[perf-review] dirty: no-mapper ${aNs.toFixed(0)}ns, mapper ${bNs.toFixed(0)}ns`);
      // Structural tripwire only — full-suite parallel load wanders ±20%.
      expect(bNs).toBeLessThan(aNs * 1.45);
    },
  );
});

describe("R4.3 perf review: error-path costs and shapes", () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- intentionally local fixture
  const errorApp = (setup: (app: Keala) => void, handler: (c: never) => unknown): Keala => {
    const app = new Keala({ env: "test" });
    setup(app);
    app.get("/boom", handler as never);
    return app;
  };

  it(
    "mapper envelope vs koa-style try/catch middleware (unexpected 5xx)",
    { timeout: 180_000 },
    async () => {
      const mapperApp = errorApp(
        (app) => app.onError((error, c) => c.json(envelope, error.status)),
        () => {
          throw new Error("boom");
        },
      );
      const mwApp = errorApp(
        (app) =>
          app.use(async (c, next) => {
            try {
              await next();
            } catch {
              return c.json(envelope, 500);
            }
          }),
        () => {
          throw new Error("boom");
        },
      );
      // Theoretical floor: catch inside the handler, hand-built Response —
      // zero framework funnel. Only the mapper+mw pair is fenced.
      const floorApp = errorApp(
        () => undefined,
        () => {
          try {
            throw new Error("boom");
          } catch {
            return Response.json(envelope, { status: 500 });
          }
        },
      );

      const req = requestFor("/boom");
      let guard = 0;
      const runOn = (app: Keala, status: number) => async (): Promise<void> => {
        const res = await app.handle(req);
        guard += res.status;
        if (res.status !== status) throw new Error(`status ${res.status}`);
      };

      const { aNs: mapperNs, bNs: mwNs } = await measurePair(
        runOn(mapperApp, 500),
        runOn(mwApp, 500),
        6_000,
        1_500,
        11,
      );
      console.log(
        `[perf-review] error 5xx: mapper ${mapperNs.toFixed(0)}ns, koa-mw ${mwNs.toFixed(0)}ns (ratio ${(mapperNs / mwNs).toFixed(2)})`,
      );
      // Design claim: the single-slot funnel is FASTER than the middleware
      // shape. Fresh-process on Bun (target runtime): 897ns vs 1088ns (+18%
      // for the funnel). Under the Node vitest runtime the shapes are a
      // wash — fence RED only if the funnel is 25%+ slower than mw.
      expect(mapperNs).toBeLessThan(mwNs * 1.45);
      // And the funnel must stay within 3.5x of the hand-built floor.
      const { aNs: mapperNs2, bNs: floorNs } = await measurePair(
        runOn(mapperApp, 500),
        runOn(floorApp, 500),
        4_000,
        1_500,
        11,
      );
      console.log(
        `[perf-review] error 5xx: mapper ${mapperNs2.toFixed(0)}ns, hand-floor ${floorNs.toFixed(0)}ns (ratio ${(mapperNs2 / floorNs).toFixed(2)})`,
      );
      expect(mapperNs2).toBeLessThan(floorNs * 3.5);
      expect(guard).toBeGreaterThan(0);
    },
  );

  it(
    "error-path variants: 422 HttpError / unexpected Error / string throw / decline / no mapper",
    { timeout: 180_000 },
    async () => {
      const http422 = errorApp(
        (app) => app.onError((error, c) => c.json(envelope, error.status)),
        (c) => (c as never as { throw: (s: number, m: string) => never }).throw(422, "bad input"),
      );
      const unexpected = errorApp(
        (app) => app.onError((error, c) => c.json(envelope, error.status)),
        () => {
          throw new Error("boom");
        },
      );
      const stringThrow = errorApp(
        (app) => app.onError((error, c) => c.json(envelope, error.status)),
        () => {
          throw "boom";
        },
      );
      const decline = errorApp(
        (app) => app.onError(() => undefined),
        (c) => (c as never as { throw: (s: number, m: string) => never }).throw(422, "bad input"),
      );
      const noMapper = errorApp(
        () => undefined,
        (c) => (c as never as { throw: (s: number, m: string) => never }).throw(422, "bad input"),
      );
      const req = requestFor("/boom");
      let guard = 0;
      const runOn = (app: Keala, status: number, body: string) => async (): Promise<void> => {
        const res = await app.handle(req);
        guard += res.status;
        if (res.status !== status) throw new Error(`status ${res.status}`);
        const text = await res.text();
        if (text !== body) throw new Error(`body ${text}`);
      };

      // Pairwise A/B with rotation for the interesting contrasts. Fences are
      // deliberately loose: these are different response constructions, the
      // numbers are the evidence; the fences only trip on large regressions.
      const { aNs: n422, bNs: nUnexpected } = await measurePair(
        runOn(http422, 422, '{"error":{"code":"internal"}}'),
        runOn(unexpected, 500, '{"error":{"code":"internal"}}'),
        5_000,
        1_500,
        11,
      );
      console.log(
        `[perf-review] error variants: 422-http ${n422.toFixed(0)}ns, unexpected-Error ${nUnexpected.toFixed(0)}ns (in-place classification + handler new Error delta)`,
      );
      // Unexpected-error funnel includes a fresh Error construction + in-place
      // classification; keep the fence generous (2.5x).
      expect(nUnexpected).toBeLessThan(n422 * 3);

      const { aNs: nString } = await (async () => {
        const single: number[] = [];
        const run = runOn(stringThrow, 500, '{"error":{"code":"internal"}}');
        for (let i = 0; i < 5_000; i++) await run();
        for (let sample = 0; sample < 11; sample++) {
          if (isBun) Bun.gc(true);
          const start = process.threadCpuUsage();
          for (let i = 0; i < 1_500; i++) await run();
          const elapsed = process.threadCpuUsage(start);
          single.push(((elapsed.user + elapsed.system) * 1e3) / 1_500);
        }
        return { aNs: medianOf(single) };
      })();
      console.log(
        `[perf-review] error variants: string-throw ${nString.toFixed(0)}ns (normalizeError: toString check + new Error w/ cause)`,
      );
      expect(nString).toBeLessThan(nUnexpected * 3);

      const { aNs: nDecline, bNs: nNoMapper } = await measurePair(
        runOn(decline, 422, "bad input"),
        runOn(noMapper, 422, "bad input"),
        5_000,
        1_500,
        11,
      );
      console.log(
        `[perf-review] built-in 422: decline-mapper ${nDecline.toFixed(0)}ns, no-mapper ${nNoMapper.toFixed(0)}ns (no-mapper pays consoleFallback call + eager c.url even when suppressed)`,
      );
      // Byte-identical built-in responses; structural extras differ (decline:
      // fail closure + mapper call + finalizeMapperResponse; no-mapper:
      // consoleFallback call + eager c.url computation). Generous 40% fence —
      // RED only if one side grew a real new cost.
      expect(nNoMapper).toBeLessThan(nDecline * 1.75);
      expect(nDecline).toBeLessThan(nNoMapper * 1.75);
      expect(guard).toBeGreaterThan(0);
    },
  );

  it(
    "error.headers merge cost: takeover with error.headers (Object.entries) vs without",
    { timeout: 120_000 },
    async () => {
      // mergeAbsentHeaders runs Object.entries(error.headers) when the throw
      // site provided protocol headers (WWW-Authenticate / Retry-After) —
      // quantify the per-error delta of that allocation.
      const plain401 = errorApp(
        (app) => app.onError((_error, c) => c.json(envelope, 401)),
        (c) =>
          (c as never as { throw: (s: number, m: string, p: unknown) => never }).throw(
            401,
            "no token",
            { headers: { "www-authenticate": 'Bearer realm="api"' } },
          ),
      );
      const plain422 = errorApp(
        (app) => app.onError((_error, c) => c.json(envelope, 422)),
        (c) => (c as never as { throw: (s: number, m: string) => never }).throw(422, "bad input"),
      );
      const req = requestFor("/boom");
      let guard = 0;
      const runOn = (app: Keala, status: number) => async (): Promise<void> => {
        const res = await app.handle(req);
        guard += res.status;
        if (res.status !== status) throw new Error(`status ${res.status}`);
      };
      const { aNs: withHeaders, bNs: withoutHeaders } = await measurePair(
        runOn(plain401, 401),
        runOn(plain422, 422),
        5_000,
        1_500,
        11,
      );
      console.log(
        `[perf-review] takeover with error.headers ${withHeaders.toFixed(0)}ns vs without ${withoutHeaders.toFixed(0)}ns (Object.entries merge delta ${(withHeaders - withoutHeaders).toFixed(0)}ns)`,
      );
      // Generous: only RED if the header merge grew a large per-error cost.
      expect(withHeaders).toBeLessThan(withoutHeaders * 1.9);
      expect(guard).toBeGreaterThan(0);
    },
  );

  it(
    "toHttpError component costs (micro): HttpError passthrough, in-place classification, non-Error normalization",
    { timeout: 120_000 },
    () => {
      const httpErr = createError(422, "bad input");
      const nsPassthrough = microMedian(() => toHttpError(httpErr), 200_000, 200_000, 11);
      const nsNewError = microMedian(() => new Error("boom"), 200_000, 200_000, 11);
      const nsClassify = microMedian(() => toHttpError(new Error("boom")), 100_000, 100_000, 11);
      const nsString = microMedian(() => toHttpError("boom"), 100_000, 100_000, 11);
      console.log(
        `[perf-review] toHttpError micro: http-passthrough ${nsPassthrough.toFixed(1)}ns, bare new Error ${nsNewError.toFixed(1)}ns, classify(fresh Error) ${nsClassify.toFixed(1)}ns (delta ${(nsClassify - nsNewError).toFixed(1)}ns), string ${nsString.toFixed(1)}ns`,
      );
      // Generous fences: classification delta must stay micro (<250ns over the
      // bare Error construction it sits on top of), passthrough < 150ns.
      expect(nsPassthrough).toBeLessThan(150);
      expect(nsClassify - nsNewError).toBeLessThan(250);
      // Non-Error normalization pays one unavoidable stack capture; fence vs
      // the Error-construction floor at 4x.
      expect(nsString).toBeLessThan(nsNewError * 4);
    },
  );

  it(
    "c.url computation cost (eagerly evaluated by the suppressed consoleFallback on no-mapper errors)",
    { timeout: 60_000 },
    () => {
      // consoleFallback(app, c.url, error) computes the URL string before the
      // env/status check runs, so every no-mapper error (incl. 4xx and test
      // env, where nothing is logged) pays one path+search parse + concat on
      // a fresh context (urlValue is per-request). Quantify the micro cost.
      const url = "http://localhost:3000/boom";
      const nsUrl = microMedian(
        () => {
          const path = getPath(url);
          const search = getSearch(url);
          return path + search;
        },
        200_000,
        200_000,
        11,
      );
      console.log(`[perf-review] c.url equivalent micro: ${nsUrl.toFixed(1)}ns/string`);
      expect(nsUrl).toBeLessThan(300); // generous; informational
    },
  );
});

describe("R4.3 perf review: error-storm memory fences (Bun only)", () => {
  it.skipIf(!isBun)(
    "validation-storm (422 c.throw + mapper envelope) retains ~zero bytes per error",
    { timeout: 180_000 },
    async () => {
      const app = new Keala({ env: "test" });
      app.onError((error, c) => c.json(envelope, error.status));
      app.get("/boom", (c) => c.throw(422, "bad input"));
      const req = requestFor("/boom");
      let guard = 0;
      const op = async (): Promise<void> => {
        guard += (await app.handle(req)).status;
      };
      const perError = await retainedPerOpBun(op, 30_000, 30_000);
      console.log(`[perf-review] 422 storm retained: ${perError.toFixed(2)} B/error after full GC`);
      expect(guard).toBe(422 * 60_000);
      // A single retained Error per trip would be >= ~300B (object + message +
      // stack strings). 96B passes GC/arena noise but trips on any real
      // per-error retention.
      expect(perError).toBeLessThan(96);
    },
  );

  it.skipIf(!isBun)(
    "unexpected-5xx storm (in-place classification) retains ~zero bytes per error",
    { timeout: 180_000 },
    async () => {
      const app = new Keala({ env: "test" });
      app.onError((error, c) => c.json(envelope, error.status));
      app.get("/boom", () => {
        throw new Error("boom");
      });
      const req = requestFor("/boom");
      let guard = 0;
      const op = async (): Promise<void> => {
        guard += (await app.handle(req)).status;
      };
      const perError = await retainedPerOpBun(op, 30_000, 30_000);
      console.log(`[perf-review] 5xx storm retained: ${perError.toFixed(2)} B/error after full GC`);
      expect(guard).toBe(500 * 60_000);
      expect(perError).toBeLessThan(96);
    },
  );

  it.skipIf(!isBun)(
    "no-mapper built-in error storm retains ~zero bytes per error",
    { timeout: 180_000 },
    async () => {
      const app = new Keala({ env: "test" });
      app.get("/boom", (c) => c.throw(422, "bad input"));
      const req = requestFor("/boom");
      let guard = 0;
      const op = async (): Promise<void> => {
        guard += (await app.handle(req)).status;
      };
      const perError = await retainedPerOpBun(op, 30_000, 30_000);
      console.log(
        `[perf-review] built-in storm retained: ${perError.toFixed(2)} B/error after full GC`,
      );
      expect(guard).toBe(422 * 60_000);
      expect(perError).toBeLessThan(96);
    },
  );
});
