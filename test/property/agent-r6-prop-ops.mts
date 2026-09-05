/**
 * ROUND 6 property rig, part 2 (per-request ops) — split from the original agent-r6-prop
 * harness for the 500-line file budget; imported by agent-r6-prop*.test.ts.
 */
import {
  COOKIE_NAMES,
  CTL,
  PRINTABLE,
  REDIRECT_TARGETS,
  ROOT_SEED,
  Rng,
  TOKEN,
  UNICODE,
  delay,
  randHeaderName,
  randHeaderValue,
  randString,
} from "./agent-r6-prop-rig.mts";
import type { Context } from "../../src/core/context/context.ts";
import { createError } from "../../src/http/errors.ts";
import type { RouteHandler } from "../../src/router/router.ts";

export const validWrites = (rng: Rng): ((c: Context) => void) => {
  const name = `x-r6-${randString(rng, 6, "abcdefghijklmnopqrstuvwxyz")}`;
  const value = randString(rng, 16, TOKEN);
  const status = rng.pick([200, 201, 204, 301, 302, 304, 418] as const);
  const useCookie = rng.bool(0.3);
  return (c: Context): void => {
    // Header/cookie writes stay legal on both sides of the commit (0.7);
    // a status write is only valid pre-commit.
    c.setHeader(name, value);
    if (useCookie) c.cookies.set("r6", "1");
    if (rng.bool(0.3) && c.res === undefined) c.status = status;
  };
};

/** Arbitrary writes — may legitimately throw (framework must answer 500). */
export const dangerousWrites = (rng: Rng): ((c: Context) => void) => {
  const ops: ((c: Context) => void)[] = [];
  const n = rng.range(1, 4);
  for (let i = 0; i < n; i++) {
    switch (rng.int(8)) {
      case 0:
        ops.push((c) => {
          c.setHeader(randHeaderName(rng), randHeaderValue(rng));
        });
        break;
      case 1:
        ops.push((c) => {
          c.append(
            randHeaderName(rng),
            rng.bool(0.5) ? randHeaderValue(rng) : [randHeaderValue(rng)],
          );
        });
        break;
      case 2:
        ops.push((c) => {
          c.cookies.set(rng.pick(COOKIE_NAMES), randString(rng, 12, PRINTABLE + CTL), {
            domain: rng.bool(0.2) ? randString(rng, 8, PRINTABLE + CTL) : undefined,
            path: rng.bool(0.2) ? randString(rng, 8, PRINTABLE + CTL + ";") : undefined,
            sameSite: rng.bool(0.1) ? ("maybe" as unknown as "lax") : "lax",
            maxAge: rng.bool(0.1) ? Number.POSITIVE_INFINITY : 60,
          });
        });
        break;
      case 3:
        ops.push((c) => {
          return c.redirect(rng.pick(REDIRECT_TARGETS));
        });
        break;
      case 4:
        ops.push((c) => {
          // 0.7: the c.message op became a body write — legal pre-commit,
          // a loud TypeError post-commit (both belong in the zoo).
          c.body = randString(rng, 12, PRINTABLE + CTL);
        });
        break;
      case 5:
        ops.push((c) => {
          c.type = randHeaderValue(rng);
        });
        break;
      case 6:
        ops.push((c) => {
          c.attachment(randString(rng, 12, PRINTABLE + CTL + UNICODE));
        });
        break;
      default:
        ops.push((c) => {
          // 0.7: c.vary is gone; append("Vary", …) is the replacement.
          c.append("Vary", randHeaderValue(rng));
        });
    }
  }
  return (c: Context): void => {
    for (const op of ops) op(c);
  };
};

export const randThrowable = (rng: Rng): unknown => {
  switch (rng.int(11)) {
    case 0:
      return createError(
        rng.pick([400, 401, 404, 405, 418, 429, 500, 503, 599]),
        randString(rng, 20, PRINTABLE),
        {
          headers: { [randHeaderName(rng)]: randHeaderValue(rng) },
          expose: rng.bool(),
        },
      );
    case 1: {
      const e = new Error(randString(rng, 20, PRINTABLE));
      (e as unknown as { status: unknown }).status = rng.pick([
        200,
        204,
        301,
        400,
        404,
        418,
        499,
        500,
        599,
        600,
        Number.NaN,
        -1,
        1e9,
        "404",
      ]);
      return e;
    }
    case 2: {
      const e = new Error("statusCode variant");
      (e as unknown as { statusCode: unknown }).statusCode = rng.pick([
        400,
        404,
        500,
        599,
        600,
        302,
        Number.NaN,
      ]);
      return e;
    }
    case 3: {
      const e = new Error("headers variant") as Error & { headers?: unknown };
      e.headers = rng.pick([
        { "x-a": randHeaderValue(rng) },
        "junk-string",
        new Map([["x-b", randHeaderValue(rng)]]),
        null,
        { "content-type": randHeaderValue(rng) },
      ]);
      return e;
    }
    case 4:
      return randString(rng, 12, PRINTABLE);
    case 5:
      return rng.int(1000);
    case 6:
      return { a: 1, b: [1, 2, 3] };
    case 7:
      return Symbol("r6-boom");
    case 8: {
      const o: { self?: unknown } = {};
      o.self = o;
      return o;
    }
    case 9:
      return undefined;
    default:
      return null;
  }
};

/** Error-instance throwables only (for the onerror-exactly-once property). */
export const randErrorInstance = (rng: Rng): Error => {
  const t = randThrowable(rng);
  return t instanceof Error ? t : new Error(String(t));
};

interface HandlerOpts {
  /** "any": full behavioral zoo (throws, thenables, double next, ...). */
  mode: "any" | "wellBehaved";
}

export const randHandler = (rng: Rng, opts: HandlerOpts): RouteHandler => {
  if (opts.mode === "wellBehaved") return wellBehavedMiddleware(rng);
  switch (rng.int(14)) {
    case 0:
      return (_c, next) => next();
    case 1:
      return async (_c, next) => {
        await delay(rng.int(3));
        await next();
      };
    case 2:
      return (c) => c.text(randString(rng, 24, PRINTABLE + UNICODE));
    case 3:
      return (c) => c.json({ a: randString(rng, 8, TOKEN), nested: { deep: true } });
    case 4: {
      const writes = dangerousWrites(rng);
      return (c) => {
        writes(c);
        return c.text("ok", rng.pick([200, 201, 204, 301, 302, 304, 418] as const));
      };
    }
    case 5:
      return () => {
        throw randThrowable(rng);
      };
    case 6:
      return () =>
        new Promise((resolve) => {
          queueMicrotask(() => resolve(undefined));
        });
    case 7: {
      // A thenable that is NOT a Promise — compose must fail loudly (500).
      // eslint-disable-next-line unicorn/no-thenable
      const thenable = {
        // eslint-disable-next-line unicorn/no-thenable
        then(resolve: (v: undefined) => void, reject: (e: unknown) => void): void {
          queueMicrotask(() =>
            rng.bool(0.5) ? resolve(undefined) : reject(new Error("thenable")),
          );
        },
      };
      // eslint-disable-next-line unicorn/no-thenable
      return () => thenable as unknown as Promise<never>;
    }
    case 8:
      return (_c, next) => {
        void next();
        void next().catch(() => undefined); // second call must throw, observed
        return undefined;
      };
    case 9: {
      const writes = validWrites(rng);
      return async (c, next) => {
        writes(c);
        await next();
        c.body = randString(rng, 16, PRINTABLE);
      };
    }
    case 10:
      return (c) => {
        // consume/lock the request body stream
        void c.raw.body?.getReader();
        return c.text("locked");
      };
    case 11:
      return () =>
        new Response(randString(rng, 16, PRINTABLE), {
          status: rng.pick([200, 201, 418, 500] as const),
        });
    case 12: {
      const writes = dangerousWrites(rng);
      return async (c, next) => {
        await next();
        writes(c);
      };
    }
    default:
      return (c) => {
        c.state.trail = randString(rng, 8, TOKEN);
        (c as unknown as Record<string, unknown>)[`junk${rng.int(5)}`] = "x";
        return next2(c);
      };
  }
};
export const next2 = (_c: unknown): undefined => undefined;

export const wellBehavedMiddleware = (rng: Rng): RouteHandler => {
  const writes = validWrites(rng);
  const pre = rng.bool();
  const wait = rng.bool(0.4);
  return async (c, next) => {
    if (pre) writes(c);
    if (wait) await delay(rng.int(2));
    await next();
    if (!pre) writes(c);
  };
};

export const ROUTE_PATHS = [
  "/",
  "/a",
  "/a/b",
  "/users/:id",
  "/users/:id/posts/:pid",
  "/files/*",
  "/a b",
  "/a%20b",
  "/x/:num(\\d+)",
  "/opt/:x?/tail",
] as const;

export const randRoutePath = (rng: Rng): string => rng.pick(ROUTE_PATHS);

// ---------------------------------------------------------------------------
// Property runner
// ---------------------------------------------------------------------------

interface PropCtx {
  skipped: number;
}

export const runProp = async (
  label: string,
  seeds: number,
  body: (rng: Rng, seed: number, ctx: PropCtx) => Promise<void> | void,
): Promise<void> => {
  const ctx: PropCtx = { skipped: 0 };
  const failures: string[] = [];
  for (let seed = 0; seed < seeds; seed++) {
    try {
      await body(new Rng(ROOT_SEED + seed), seed, ctx);
    } catch (err) {
      const message = err instanceof Error ? `${err.message}` : String(err);
      failures.push(`  seed ${seed}: ${message.slice(0, 400)}`);
      if (failures.length >= 5) break;
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${label}: ${failures.length}+ failing seed(s), ${ctx.skipped} skipped samples\n` +
        failures.join("\n"),
    );
  }
};

export const wireUnsafe = (v: string): boolean =>
  v.includes("\r") || v.includes("\n") || v.includes("\0");

export const scanWire = (res: Response, label: string): void => {
  for (const [k, v] of res.headers.entries()) {
    if (wireUnsafe(k) || wireUnsafe(v)) {
      throw new Error(`${label}: unsafe header ${JSON.stringify(k)}=${JSON.stringify(v)}`);
    }
  }
  for (const v of res.headers.getSetCookie()) {
    if (wireUnsafe(v)) throw new Error(`${label}: unsafe set-cookie ${JSON.stringify(v)}`);
  }
  if (wireUnsafe(res.statusText)) {
    throw new Error(`${label}: unsafe statusText ${JSON.stringify(res.statusText)}`);
  }
};
