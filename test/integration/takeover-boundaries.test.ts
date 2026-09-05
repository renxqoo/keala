import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Keala } from "../../src/core/app.ts";
import type { Context } from "../../src/core/context/context.ts";

const BASE = "http://localhost:3000";

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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const requestFor = (path: string, init?: RequestInit): Request =>
  new Request(`${BASE}${path}`, init);

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

const errorLogText = (): string => consoleError.mock.calls.flat().join(" ");

afterAll(() => {
  consoleError.mockRestore();
});

// ---------------------------------------------------------------------------

describe("R4.3 agent review: thenable mapper returns (rule 5 'await the thenable')", () => {
  // A hand-rolled thenable that synchronously fulfills and returns undefined
  // from .then — the classic thenable shape (any non-native promise). Per
  // rule 5 the funnel must AWAIT it and settle a Response.
  // eslint-disable-next-line unicorn/consistent-function-scoping -- intentionally local fixture
  const syncThenable = (value: unknown): unknown => ({
    // eslint-disable-next-line unicorn/no-thenable -- hand-rolled thenables are the test subject
    then(onFulfilled: (v: unknown) => unknown) {
      onFulfilled(value);
      return undefined; // not a native Promise
    },
  });

  it("pooling:false — app.handle must settle a Response, never undefined", async () => {
    const app = new Keala({ env: "test" });
    app.get("/e", () => {
      throw new Error("boom");
    });
    app.onError(
      () => syncThenable(new Response("via-thenable", { status: 502 })) as unknown as Response,
    );
    const res = await app.handle(requestFor("/e"));
    // CONTRACT-CORRECT: the takeover settles. Observed: app.handle resolves
    // to `undefined` — buildErrorResponse returns out.then(...) verbatim and
    // the custom .then returns undefined, so the funnel leaks a non-Promise.
    expect(res instanceof Response, `observed: ${String(res)}`).toBe(true);
    expect((res as Response).status).toBe(502);
    expect(await (res as Response).text()).toBe("via-thenable");
  });

  it("pooling:false, async chain — app.handle must settle a Response, never undefined", async () => {
    const app = new Keala({ env: "test" });
    app.get("/e", async () => {
      throw new Error("boom");
    });
    app.onError(
      () => syncThenable(new Response("via-thenable", { status: 502 })) as unknown as Response,
    );
    const out = await settle(app.handle(requestFor("/e")));
    expect(out.ok).toBe(true);
    expect(out.value instanceof Response, `observed: ${String(out.value)}`).toBe(true);
  });

  it("pooling:true — app.handle must never throw synchronously", async () => {
    const app = new Keala({ env: "test", pooling: true });
    app.get("/e", () => {
      throw new Error("boom");
    });
    app.onError(
      () => syncThenable(new Response("via-thenable", { status: 502 })) as unknown as Response,
    );
    // CONTRACT-CORRECT (rule 8): never throws, settles a Response. Observed:
    // retireWithBody reads .body of the leaked undefined — app.handle THROWS
    // "undefined is not an object (evaluating 'value.body')" synchronously.
    let res: Response;
    try {
      res = await app.handle(requestFor("/e"));
    } catch (syncThrow) {
      throw new Error(`app.handle threw synchronously: ${String((syncThrow as Error)?.message)}`, {
        cause: syncThrow,
      });
    }
    expect(res.status).toBe(502);
    await res.text();
  });

  it("pooling:true, async chain — app.handle must never reject", async () => {
    const app = new Keala({ env: "test", pooling: true });
    app.get("/e", async () => {
      throw new Error("boom");
    });
    app.onError(
      () => syncThenable(new Response("via-thenable", { status: 502 })) as unknown as Response,
    );
    const out = await settle(app.handle(requestFor("/e")));
    // CONTRACT-CORRECT (rule 8: app.handle never rejects). Observed: the
    // release handler throws on the leaked undefined and app.handle REJECTS.
    expect(out.ok, `observed rejection: ${String((out.error as Error)?.message)}`).toBe(true);
    expect(out.value instanceof Response).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding: reused takeover Response (module-level constant pattern)
// ---------------------------------------------------------------------------

describe("R4.3 agent review: reused takeover Response", () => {
  it(
    "pooling:false — second request must ship a usable takeover, never a silently broken body",
    async () => {
      const SHARED = new Response("shared-error-page", {
        status: 500,
        headers: { "x-shared": "1" },
      });
      const app = new Keala({ env: "test" });
      app.get("/e", () => {
        throw new Error("boom");
      });
      app.onError(() => SHARED);

      const r1 = await app.handle(requestFor("/e"));
      expect(await r1.text()).toBe("shared-error-page");

      // A consumed body can never ship again (no clone, no re-read) — the
      // implementable contract is a LOUD static 500: the framework detects
      // the unusable Response, console.errors it, and the boundary stays
      // intact. Before the fix the disturbed object shipped verbatim and the
      // consumer's read threw "Body already used".
      // Use the file-level spy (a local spyOn+mockRestore here would restore
      // the ORIGINAL console.error and blind every later test in the file).
      consoleError.mockClear();
      const second = await app.handle(requestFor("/e"));
      expect(second.status).toBe(500);
      expect(second.bodyUsed).toBe(false);
      expect(await second.text()).toBe("Internal Server Error");
      expect(consoleError.mock.calls.length).toBeGreaterThan(0);
      expect(errorLogText()).toContain("consumed Response");
    },
    STEP_MS,
  );

  it(
    "pooling:true — takeover lost on reuse must fail loudly, not silently swap to a plain 500",
    async () => {
      const SHARED = new Response("shared-error-page", { status: 500 });
      const app = new Keala({ env: "test", pooling: true });
      app.get("/e", () => {
        throw new Error("boom");
      });
      let calls = 0;
      app.onError(() => {
        calls += 1;
        return SHARED;
      });

      const r1 = await app.handle(requestFor("/e"));
      expect(await r1.text()).toBe("shared-error-page");

      consoleError.mockClear();
      const r2 = await app.handle(requestFor("/e"));
      const body = await settle(r2.text());
      // CONTRACT-CORRECT: intact takeover or a loud failure. Observed: silent
      // degradation — plain 500 "Internal Server Error" from retireWithBody's
      // body-locked catch, mapper not re-consulted, nothing logged.
      const loud = consoleError.mock.calls.length > 0;
      expect(
        (body.ok && body.value === "shared-error-page") || loud,
        `observed status=${r2.status} body=${body.ok ? JSON.stringify(body.value) : "unreadable"}, console.error=${consoleError.mock.calls.length}, mapper calls=${calls}`,
      ).toBe(true);
    },
    STEP_MS,
  );

  it.skipIf(typeof Bun === "undefined")(
    "Bun.serve wire — the takeover must reach the client on every request",
    async () => {
      const SHARED = new Response("shared-error-page", { status: 500 });
      const app = new Keala({ env: "test" });
      app.get("/e", () => {
        throw new Error("boom");
      });
      app.onError(() => SHARED);
      const server = app.listen(0);
      try {
        const base = `http://127.0.0.1:${server.port}/e`;
        const first = await fetch(base);
        expect(first.status).toBe(500);
        expect(await first.text()).toBe("shared-error-page");

        consoleError.mockClear();
        const second = await fetch(base);
        const text = await second.text();
        // A consumed body cannot ship twice — the contract-correct wire
        // result is the framework's OWN loud 500 (static body, not Bun's
        // default error page substitution), with the mapper's bug logged.
        expect(
          second.status === 500 && text === "Internal Server Error",
          `observed status=${second.status} content-type=${second.headers.get("content-type")} body=${JSON.stringify(text.slice(0, 60))}…`,
        ).toBe(true);
        expect(consoleError.mock.calls.length).toBeGreaterThan(0);
        expect(consoleError.mock.calls.flat().join(" ")).toContain("consumed Response");
      } finally {
        server.stop(true);
      }
    },
    STEP_MS,
  );
});

// ---------------------------------------------------------------------------
// Finding: error.headers content-describing headers merged onto a takeover

// ---------------------------------------------------------------------------

describe("R4.3 agent review: concurrency and pooling isolation", () => {
  for (const pooling of [false, true]) {
    it(
      `concurrent in-flight errors share the single mapper slot without cross-talk (pooling=${pooling})`,
      async () => {
        const app = new Keala({ env: "test", pooling });
        app.all("/x", async (c) => {
          const depth = Number(c.query("d") ?? "1");
          await sleep(Math.min(depth, 5)); // seeded-free, bounded jitter
          if (depth % 2 === 0) c.throw(422, "even", { expose: true });
          throw new Error("odd boom");
        });
        const seen: Array<{ status: number; ctx: Context; rid: number }> = [];
        app.onError(async (error, c) => {
          const rid = Number(c.query("rid") ?? "-1");
          seen.push({ status: error.status, ctx: c, rid });
          await Promise.resolve();
          return new Response(`rid-${rid}`, { status: error.status });
        });

        const N = 30;
        const expected = new Map<number, { status: number; body: string }>();
        const requests = Array.from({ length: N }, (_, i) => {
          const depth = i % 7;
          const is4xx = depth % 2 === 0;
          const status = is4xx ? 422 : 500;
          expected.set(i, { status, body: `rid-${i}` });
          return settle(app.handle(requestFor(`/x?d=${depth}&rid=${i}`)));
        });
        const results = await Promise.all(requests);
        const bodies = await Promise.all(results.map((r) => settle((r.value as Response).text())));

        // Every request settles, keeps its own status and its own body —
        // no cross-talk through the shared single mapper slot.
        for (let i = 0; i < N; i += 1) {
          expect(results[i]?.ok, `request ${i} settled`).toBe(true);
          const want = expected.get(i);
          expect(
            (results[i] as unknown as { value: Response }).value.status,
            `request ${i} status`,
          ).toBe(want?.status);
          expect(bodies[i]?.value, `request ${i} body`).toBe(want?.body);
        }
        expect(seen.length).toBe(N);
        // Every request saw its OWN context (no early recycling while in flight).
        expect(new Set(seen.map((s) => s.ctx)).size).toBe(N);
        // Every request's error was classified for THAT request (order of the
        // mapper calls is jitter-dependent; rid identity is what matters).
        for (const s of seen) {
          expect(s.status).toBe(expected.get(s.rid)?.status);
        }
        expect(new Set(seen.map((s) => s.rid))).toEqual(new Set(expected.keys()));
      },
      STEP_MS,
    );
  }

  it(
    "pooling: a late write on a retired context throws the guard and does not corrupt the next request",
    async () => {
      const app = new Keala({ env: "test", pooling: true });
      app.get("/e", () => {
        throw new Error("boom");
      });
      let lateFired = false;
      let lateError: unknown;
      app.onError((_error, c) => {
        setTimeout(() => {
          try {
            // U3c: the body setter is gone — the late write rides the header
            // surface (setHeader throws on the retired prototype).
            c.setHeader("X-Late", "LATE-WRITE");
          } catch (err) {
            lateError = err;
          } finally {
            lateFired = true;
          }
        }, 25);
        return undefined;
      });

      const res = await app.handle(requestFor("/e"));
      expect(res.status).toBe(500);
      await res.text(); // consume the body -> context retires into the pool

      await sleep(120);
      expect(lateFired).toBe(true);
      expect((lateError as Error)?.message).toContain("retired");

      // The recycled context serves the next request cleanly.
      const next = await app.handle(requestFor("/e"));
      expect(next.status).toBe(500);
      expect(await next.text()).toBe("Internal Server Error");
    },
    STEP_MS,
  );

  it(
    "pooling: an async mapper's pending context never bleeds into the next request",
    async () => {
      const app = new Keala({ env: "test", pooling: true });
      app.get("/e", () => {
        throw new Error("boom");
      });
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const seen: string[] = [];
      app.onError(async (error, c) => {
        const id = c.query("rid") as string;
        seen.push(id as string);
        if (id === "slow") await gate; // slow mapper stays in flight
        return new Response(`r-${id}-${error.status}`, { status: error.status });
      });

      const slow = app.handle(requestFor("/e?rid=slow")).then(async (r) => ({
        status: r.status,
        body: await r.text(),
      }));
      await sleep(10);

      // While the slow mapper holds its context, a second error request must
      // settle independently with its OWN context and takeover.
      const fast = await settle(app.handle(requestFor("/e?rid=fast")));
      expect(fast.ok).toBe(true);
      expect((fast.value as Response).status).toBe(500);
      expect(await (fast.value as Response).text()).toBe("r-fast-500");

      release?.();
      const slowOut = await settle(slow);
      expect(slowOut.ok).toBe(true);
      expect(slowOut.value).toEqual({ status: 500, body: "r-slow-500" });
      expect(seen).toEqual(["slow", "fast"]);
    },
    STEP_MS,
  );
});

// ---------------------------------------------------------------------------
// Seeded path fuzz: adversarial request paths still settle
// ---------------------------------------------------------------------------

describe("R4.3 agent review: seeded path fuzz", () => {
  it(
    "weird request paths through the error funnel always settle a valid Response",
    async () => {
      const rng = mulberry32(0x5eed);
      const alphabet = ["/", "%2f", "%2F", "..", ";", "?", "#", "%zz", "%00", "😀", "a", "//"];
      const paths = Array.from({ length: 60 }, () => {
        let p = "";
        const len = 1 + Math.floor(rng() * 6);
        for (let i = 0; i < len; i += 1) p += alphabet[Math.floor(rng() * alphabet.length)];
        return p;
      });
      paths.push(`/${"long".repeat(600)}`);

      const app = new Keala({ env: "test" });
      app.all("/x", (c) => {
        if (c.path.includes(";")) c.throw(422, "semicolon", { expose: true });
        throw new Error("path boom");
      });

      for (const raw of paths) {
        // Origin-form only: real request targets always begin with "/" — a
        // Request the harness itself cannot construct is pre-framework.
        const path = raw.startsWith("/") ? raw : `/${raw}`;
        let request: Request;
        try {
          request = requestFor(path);
        } catch {
          continue; // URL-parser-level rejection, never reaches the framework
        }
        let handled: Settled<Response>;
        try {
          handled = await settle(app.handle(request));
        } catch (syncThrow) {
          throw new Error(
            `app.handle threw synchronously for ${JSON.stringify(path)}: ${String(syncThrow)}`,
          );
        }
        expect(handled.ok, `app.handle must settle for path ${JSON.stringify(path)}`).toBe(true);
        const res = handled.value as Response;
        expect(res instanceof Response, `path ${JSON.stringify(path)}`).toBe(true);
        expect(
          Number.isInteger(res.status) && res.status >= 200 && res.status <= 599,
          `path ${JSON.stringify(path)}`,
        ).toBe(true);
        const body = await settle(res.text());
        expect(body.ok, `body must be readable for path ${JSON.stringify(path)}`).toBe(true);
      }
    },
    STEP_MS,
  );
});
