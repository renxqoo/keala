/**
 * Agent contract review — R4.3 error policy (commit 6ac9706).
 * Contract source: docs/HOTPATH-R4-3-MIGRATION-ERROR-POLICY.md §2.2 (8 rules).
 *
 * Angle: contract violations + availability hazards of the single-slot error
 * mapper funnel. Property/fuzz style: seeded PRNG, deterministic full-matrix
 * enumeration, generous timeouts, no wall-clock dependence beyond coarse
 * sleep bounds for timer-based guards.
 *
 * Red tests assert the CONTRACT-correct behavior; each finding test is
 * annotated with observed vs expected in its assertion messages.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Keala } from "../../src/core/app.ts";
import type { Application } from "../../src/core/app.ts";
import type { Context } from "../../src/core/context/context.ts";
import type { HttpError } from "../../src/http/errors.ts";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const BASE = "http://localhost:3000";

const requestFor = (path: string, init?: RequestInit): Request =>
  new Request(`${BASE}${path}`, init);

/** Deterministic PRNG (mulberry32) — no Math.random, no flakiness. */
const mulberry32 = (seedValue: number): (() => number) => {
  let seed = seedValue;
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const STEP_MS = 30_000;
const ATOMIC_MS = 4_000;

interface Settled<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

/** Race a promise against a hard deadline — hangs become failures, not flake. */
const settle = async <T>(input: PromiseLike<T> | T, ms = ATOMIC_MS): Promise<Settled<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: no settlement within ${ms}ms`)), ms);
  });
  try {
    const value = await Promise.race([Promise.resolve(input), deadline]);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

let consoleError: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(() => {
  consoleError.mockRestore();
});

// ---------------------------------------------------------------------------
// Fuzz matrix: failure injections x mapper behaviors x methods x pooling
// ---------------------------------------------------------------------------

/** Every injection trips the error funnel exactly once per request. */
interface Injection {
  id: string;
  wire(app: Application): void;
}

const circular = (): Record<string, unknown> => {
  const obj: Record<string, unknown> = {};
  obj["self"] = obj;
  return obj;
};

const INJECTIONS: readonly Injection[] = [
  {
    id: "sync-throw-error",
    wire: (app) =>
      void app.all("/x", () => {
        throw new Error("sync boom");
      }),
  },
  {
    id: "sync-throw-typeerror",
    wire: (app) =>
      void app.all("/x", () => {
        throw new TypeError("typed boom");
      }),
  },
  {
    id: "async-throw",
    wire: (app) =>
      void app.all("/x", async () => {
        throw new Error("async boom");
      }),
  },
  {
    id: "async-reject-non-error",
    wire: (app) => void app.all("/x", async () => Promise.reject("plain-string-rejection")),
  },
  {
    id: "c-throw-4xx-with-headers",
    wire: (app) =>
      void app.all("/x", (c) =>
        c.throw(422, "invalid input", {
          expose: true,
          headers: { "www-authenticate": "Bearer" },
        }),
      ),
  },
  {
    id: "c-throw-5xx",
    wire: (app) => void app.all("/x", (c) => c.throw(503, "down", { expose: true })),
  },
  {
    id: "async-c-throw-4xx",
    wire: (app) =>
      void app.all("/x", async (c) => {
        c.throw(400, "bad", { expose: true });
      }),
  },
  {
    id: "throw-string",
    wire: (app) =>
      void app.all("/x", () => {
        throw "string-boom";
      }),
  },
  {
    id: "throw-object",
    wire: (app) =>
      void app.all("/x", () => {
        throw { weird: true };
      }),
  },
  {
    id: "throw-bigint",
    wire: (app) =>
      void app.all("/x", () => {
        throw 42n;
      }),
  },
  {
    id: "throw-null",
    wire: (app) =>
      void app.all("/x", () => {
        throw null;
      }),
  },
  {
    id: "throw-undefined",
    wire: (app) =>
      void app.all("/x", () => {
        throw undefined;
      }),
  },
  {
    // finalize failure: a circular body explodes inside JSON serialization
    id: "finalize-circular-state-body",
    wire: (app) =>
      void app.all("/x", (c) => {
        return c.json(circular());
      }),
  },
  {
    // finalize failure via the sugar constructor (throws inside the handler)
    id: "finalize-circular-json-sugar",
    wire: (app) => void app.all("/x", (c) => c.json(circular())),
  },
  {
    id: "middleware-async-reject",
    wire: (app) => {
      app.use(async () => {
        throw new Error("mw boom");
      });
      void app.all("/x", (c) => c.text("never reached"));
    },
  },
];

type MapperFn = (error: HttpError, c: Context) => Response | Promise<Response> | void;

interface MapperFactory {
  id: string;
  /** Requests issued against one app (reused-response needs two). */
  requests: number;
  make(): MapperFn;
}

const MAPPERS: readonly MapperFactory[] = [
  { id: "none", requests: 1, make: () => () => undefined },
  { id: "decline-void", requests: 1, make: () => () => undefined },
  {
    id: "takeover",
    requests: 1,
    make: () => (_e) => new Response("took-over", { status: 502, headers: { "x-takeover": "1" } }),
  },
  {
    id: "takeover-async",
    requests: 1,
    make: () => async (e) => {
      await Promise.resolve();
      return new Response(`async-${e.status}`, { status: e.status });
    },
  },
  {
    id: "mapper-throw-sync",
    requests: 1,
    make: () => () => {
      throw new Error("mapper sync bug");
    },
  },
  {
    id: "mapper-reject-async",
    requests: 1,
    make: () => async () => {
      throw new Error("mapper async bug");
    },
  },
  { id: "garbage-string", requests: 1, make: () => () => "not-a-response" as unknown as Response },
  {
    id: "garbage-object-async",
    requests: 1,
    make: () => async () => ({ nope: true }) as unknown as Response,
  },
  {
    // thenable resolving with non-Response garbage -> loud static 500
    id: "thenable-garbage",
    requests: 1,
    make: () => () =>
      ({
        // eslint-disable-next-line unicorn/no-thenable -- hand-rolled thenable under test
        then: (onFul: (v: unknown) => void) => {
          onFul(42);
        },
      }) as unknown as Response,
  },
  {
    // thenable whose .then itself throws -> mapper failure path
    id: "thenable-throwing-then",
    requests: 1,
    make: () => () =>
      ({
        // eslint-disable-next-line unicorn/no-thenable -- hand-rolled thenable under test
        then: () => {
          throw new Error("then blew");
        },
      }) as unknown as Response,
  },
  {
    // module-level constant takeover — a realistic enterprise-envelope pattern
    id: "reused-response",
    requests: 2,
    make: () => {
      const shared = new Response("shared-error-page", {
        status: 500,
        headers: { "x-shared": "1" },
      });
      return () => shared;
    },
  },
  {
    // body pre-locked by a foreign reader (mapper bug: read its own body)
    id: "locked-body-response",
    requests: 1,
    make: () => {
      const locked = new Response("locked-body", { status: 500 });
      locked.body?.getReader();
      return () => locked;
    },
  },
];

describe("R4.3 agent review: never-reject property fuzz (full matrix, seeded)", () => {
  it(
    "every injection x mapper x method x pooling combination settles a valid, readable Response",
    async () => {
      const rng = mulberry32(0xc0ffee);
      const combos: Array<{
        injection: Injection;
        mapper: MapperFactory;
        method: string;
        pooling: boolean;
      }> = [];
      for (const injection of INJECTIONS) {
        for (const mapper of MAPPERS) {
          for (const method of ["GET", "HEAD", "POST"]) {
            for (const pooling of [false, true]) {
              combos.push({ injection, mapper, method, pooling });
            }
          }
        }
      }
      // Seeded Fisher-Yates: randomized execution order, full coverage.
      for (let i = combos.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        const left = combos[i] as (typeof combos)[number];
        const right = combos[j] as (typeof combos)[number];
        combos[i] = right;
        combos[j] = left;
      }

      const failures: string[] = [];
      for (const { injection, mapper, method, pooling } of combos) {
        const comboId = `${injection.id} | mapper=${mapper.id} | ${method} | pooling=${pooling}`;
        const app = new Keala({ env: "test", pooling });
        injection.wire(app);

        let calls = 0;
        const seen: HttpError[] = [];
        const fn = mapper.make();
        if (mapper.id !== "none") {
          app.onError((error, c) => {
            calls += 1;
            seen.push(error);
            return fn(error, c);
          });
        }

        const expectedCalls = mapper.id === "none" ? 0 : mapper.requests;
        for (let i = 0; i < mapper.requests; i += 1) {
          let handled: Settled<Response>;
          try {
            handled = await settle(app.handle(requestFor("/x", { method })));
          } catch (syncThrow) {
            failures.push(
              `${comboId} [req ${i + 1}]: app.handle THREW synchronously: ${String(syncThrow)}`,
            );
            continue;
          }
          if (!handled.ok) {
            failures.push(
              `${comboId} [req ${i + 1}]: app.handle did not settle (${String((handled.error as Error)?.message)})`,
            );
            continue;
          }
          const res = handled.value as Response;
          if (!(res instanceof Response)) {
            failures.push(`${comboId} [req ${i + 1}]: settled non-Response: ${String(res)}`);
            continue;
          }
          if (!Number.isInteger(res.status) || res.status < 200 || res.status > 599) {
            failures.push(`${comboId} [req ${i + 1}]: invalid status ${res.status}`);
            continue;
          }
          // The shipped body must be readable exactly once by the consumer.
          const body = await settle(res.text());
          if (!body.ok) {
            failures.push(
              `${comboId} [req ${i + 1}]: response body UNREADABLE: ${String((body.error as Error)?.message)}`,
            );
          } else if (method === "HEAD" && (body.value as string).length > 0) {
            failures.push(`${comboId} [req ${i + 1}]: HEAD shipped a body`);
          }
        }

        if (calls !== expectedCalls) {
          failures.push(`${comboId}: mapper called ${calls}x, expected exactly ${expectedCalls}`);
        }
        for (const [idx, error] of seen.entries()) {
          const httpShaped =
            error instanceof Error &&
            typeof error.status === "number" &&
            error.status >= 400 &&
            error.status <= 599;
          if (!httpShaped) {
            failures.push(`${comboId}: mapper arg ${idx} is not an HttpError: ${String(error)}`);
          }
        }
      }

      expect(
        failures.slice(0, 60).join("\n"),
        `${failures.length} failing combinations (showing first 60)`,
      ).toBe("");
    },
    STEP_MS * 6,
  );
});

// ---------------------------------------------------------------------------
// Mapper call-count: exactly once per funnel trip, no re-entry
// ---------------------------------------------------------------------------

describe("R4.3 agent review: mapper call count", () => {
  const cases: Array<{ id: string; wire(app: Application): void }> = [
    {
      id: "sync throw",
      wire: (app) =>
        void app.all("/x", () => {
          throw new Error("boom");
        }),
    },
    {
      id: "async reject",
      wire: (app) =>
        void app.all("/x", async () => {
          throw new Error("boom");
        }),
    },
    {
      id: "c.throw 4xx",
      wire: (app) => void app.all("/x", (c) => c.throw(422, "bad", { expose: true })),
    },
    {
      id: "c.throw 5xx",
      wire: (app) => void app.all("/x", (c) => c.throw(503, "down", { expose: true })),
    },
    {
      id: "throw non-Error",
      wire: (app) =>
        void app.all("/x", () => {
          throw "str";
        }),
    },
    {
      id: "finalize failure",
      wire: (app) =>
        void app.all("/x", (c) => {
          return c.json(circular());
        }),
    },
    {
      id: "ws upgrade rejected",
      wire: (app) => void app.ws("/x", { message: () => undefined }),
    },
  ];

  for (const takeover of [false, true]) {
    it(
      `exactly one mapper call per funnel trip (takeover=${takeover})`,
      async () => {
        for (const testCase of cases) {
          const app = new Keala({ env: "test" });
          testCase.wire(app);
          let calls = 0;
          app.onError((error) => {
            calls += 1;
            return takeover
              ? new Response(`mapped-${error.status}`, { status: error.status })
              : undefined;
          });
          const request =
            testCase.id === "ws upgrade rejected"
              ? requestFor("/x")
              : requestFor("/x", { method: "GET" });
          const out = await settle(app.handle(request));
          expect(out.ok, `${testCase.id}: app.handle settled`).toBe(true);
          await settle((out.value as Response).text());
          expect(calls, `${testCase.id}: mapper call count`).toBe(1);
        }
      },
      STEP_MS,
    );
  }

  it("a failing mapper is never re-entered (no recursion)", async () => {
    const app = new Keala({ env: "test" });
    app.all("/x", () => {
      throw new Error("original");
    });
    let calls = 0;
    app.onError(() => {
      calls += 1;
      throw new Error("mapper bug");
    });
    const res = await app.handle(requestFor("/x"));
    expect(res.status).toBe(500);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
