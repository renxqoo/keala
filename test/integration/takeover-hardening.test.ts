import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { startBunServer } from "../../src/adapters/bun.ts";
import type { HttpError } from "../../src/http/errors.ts";

const BASE = "http://localhost:3000";

const requestFor = (path: string, init?: RequestInit): Request =>
  new Request(`${BASE}${path}`, init);

const STEP_MS = 30_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let consoleError: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const errorLogText = (): string => consoleError.mock.calls.flat().join(" ");

afterAll(() => {
  consoleError.mockRestore();
});

// ---------------------------------------------------------------------------

describe("R4.3 agent review: if-absent merge scope (rule 3)", () => {
  it("content-describing error.headers are never merged onto a takeover Response", async () => {
    const app = new Keala({ env: "test" });
    app.get("/cl", (c) =>
      c.throw(503, "x", {
        expose: true,
        headers: {
          "content-length": "999",
          "content-type": "application/evil",
          "retry-after": "30",
        },
      }),
    );
    app.onError(() => new Response("short", { status: 503, headers: { "x-takeover": "1" } }));

    const res = await app.handle(requestFor("/cl"));
    // Rule 3: "content 描述头永不补" — content-type/content-length must never
    // be merged from any source. Observed: content-length=999 (body is
    // 5 bytes) and content-type=application/evil ride onto the takeover.
    expect(res.headers.get("content-length"), "content-length must not merge").toBeNull();
    expect(res.headers.get("content-type"), "content-type must not merge").not.toBe(
      "application/evil",
    );
    // A legit protocol header from error.headers still merges if-absent.
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("x-takeover")).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// HEAD takeover correctness (green lock)
// ---------------------------------------------------------------------------

describe("R4.3 agent review: HEAD takeover beyond body strip", () => {
  it("preserves status, statusText and headers while stripping the body", async () => {
    const app = new Keala({ env: "test" });
    app.get("/h", () => {
      throw new Error("boom");
    });
    app.onError(
      () =>
        new Response("secret-body", {
          status: 503,
          statusText: "Out of Honey",
          headers: {
            "x-keep": "yes",
            "content-type": "application/x-demo",
            "retry-after": "30",
          },
        }),
    );
    const res = await app.handle(new Request(`${BASE}/h`, { method: "HEAD" }));
    expect(res.status).toBe(503);
    expect(res.statusText).toBe("Out of Honey");
    expect(res.headers.get("x-keep")).toBe("yes");
    expect(res.headers.get("content-type")).toBe("application/x-demo");
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.text()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Finding: bodied empty-status takeover escapes app.handle unsanitized
// ---------------------------------------------------------------------------

describe("R4.3 agent review: empty-status takeover sanitization", () => {
  it("a bodied 204/304 takeover is sanitized exactly like the committed path", async () => {
    const app = new Keala({ env: "test" });
    app.get("/e", () => {
      throw new Error("boom");
    });
    app.onError(
      () =>
        new Response("MUST-NOT-SHIP", { status: 204, headers: { "content-type": "text/plain" } }),
    );
    const res = await app.handle(requestFor("/e"));
    // CONTRACT-CORRECT (respond.ts finalize does this for committed
    // Responses — RFC 9110 §8.6): a 204 MUST NOT carry a body or
    // content-describing headers. Bun constructs a bodied 204 (the funnel
    // must sanitize it); undici REFUSES the construction, so on Node the
    // mapper itself throws and the loud-failure path answers the 500.
    const bunConstructsBodied204 = (() => {
      try {
        void new Response("x", { status: 204 });
        return true;
      } catch {
        return false;
      }
    })();
    if (bunConstructsBodied204) {
      expect(res.body, "bodied 204 must be sanitized").toBeNull();
      expect(res.headers.get("content-type")).toBeNull();
    } else {
      expect(res.status).toBe(500);
      expect(consoleError.mock.calls.length).toBeGreaterThan(0);
    }
  });

  it("mapper constructing an invalid Response (status 0) is a mapper failure: static 500 + console.error", async () => {
    const app = new Keala({ env: "test" });
    app.get("/e", () => {
      throw new Error("boom");
    });
    app.onError(
      () => new Response("x", { status: 0 }) as unknown as Response, // constructor throws
    );
    const res = await app.handle(requestFor("/e"));
    expect(res.status).toBe(500);
    expect(errorLogText()).toContain("error mapper failed");
  });
});

// ---------------------------------------------------------------------------
// Finding: frozen (non-extensible) Errors break in-place classification
// ---------------------------------------------------------------------------

describe("R4.3 agent review: frozen throwables", () => {
  it("request funnel: frozen Error settles 500 but silently skips the mapper (rule 2 gap)", async () => {
    const frozen = Object.freeze(new Error("frozen boom"));
    const app = new Keala({ env: "test" });
    app.get("/f", () => {
      throw frozen;
    });
    let calls = 0;
    app.onError((error) => {
      calls += 1;
      return new Response("mapped", { status: error.status });
    });
    const res = await app.handle(requestFor("/f"));
    // Never-reject holds…
    expect(res.status).toBe(500);
    // …but rule 2 ("到达 mapper 的错误恒为 HttpError") means the mapper must
    // see it. Observed: toHttpError's in-place `status = 500` write throws on
    // the frozen object, errorResponse catches, static 500 ships — the mapper
    // is silently skipped (0 calls, no console output either).
    expect(calls, "mapper must be consulted exactly once").toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ws / serve runtime error paths (consoleFallback) — funnel edges
// ---------------------------------------------------------------------------

describe("R4.3 agent review: ws + serve runtime error paths", () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- intentionally local fixture
  const fakeServer = () => {
    const opts: Record<string, unknown> = {};
    const impl = (options: Record<string, unknown>) => {
      Object.assign(opts, options);
      return {
        port: 0,
        hostname: "127.0.0.1",
        stop() {
          /* fake */
        },
        fetch: async () => new Response("ok"),
        reload() {
          /* fake */
        },
      };
    };
    return { opts, impl };
  };

  it("request-path ws upgrade rejection (upgrade=false) reaches the mapper as a 400 HttpError", async () => {
    const app = new Keala({ env: "test" });
    app.ws("/socket", { message: () => undefined });
    const seen: HttpError[] = [];
    app.onError((error) => {
      seen.push(error);
      return undefined;
    });
    const res = await app.handle(requestFor("/socket"), { server: { upgrade: () => false } });
    expect(res.status).toBe(400);
    expect(seen.length).toBe(1);
    expect(seen[0]?.status).toBe(400);
    expect(seen[0] instanceof Error).toBe(true);
  });

  it("serve error callback answers a plain 500 and console.errors the fault (dev env)", async () => {
    const app = new Keala({ env: "development" });
    const { opts, impl } = fakeServer();
    startBunServer(app, { port: 0 }, undefined, impl);
    const errorHandler = opts["error"] as (error: Error) => Response;
    consoleError.mockClear();
    const res = errorHandler(new Error("serve blew up"));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(500);
    const logged = errorLogText();
    expect(logged).toContain("serve blew up");
    expect(logged).toContain("at unknown");
  });

  it("a rejecting ws runtime handler reaches consoleFallback without escaping the dispatch", async () => {
    const app = new Keala({ env: "development" });
    app.ws("/socket", {
      message: () => {
        throw new Error("ws handler blew up");
      },
    });
    const { opts, impl } = fakeServer();
    startBunServer(app, { port: 0 }, undefined, impl);
    const ws = opts["websocket"] as {
      message(wsInput: unknown, message: string): void;
    };
    consoleError.mockClear();
    expect(() => ws.message({ data: { wsKey: "/socket", ctx: {} } }, "hello")).not.toThrow();
    await sleep(50);
    expect(errorLogText()).toContain("ws handler blew up");
    expect(errorLogText()).toContain("at unknown");
  });

  it(
    "a ws handler throwing a FROZEN Error must not become an unhandledRejection",
    async () => {
      const app = new Keala({ env: "development" });
      const frozen = Object.freeze(new Error("ws frozen boom"));
      app.ws("/socket", {
        message: () => {
          throw frozen;
        },
      });
      const { opts, impl } = fakeServer();
      startBunServer(app, { port: 0 }, undefined, impl);
      const ws = opts["websocket"] as {
        message(wsInput: unknown, message: string): void;
      };

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      (process.on as unknown as (event: string, fn: (reason: unknown) => void) => void)(
        "unhandledRejection",
        onUnhandled,
      );
      try {
        ws.message({ data: { wsKey: "/socket", ctx: {} } }, "hello");
        await sleep(80);
        // CONTRACT-CORRECT: the bun.ts dispatch wrapper exists precisely so
        // "a rejecting async ws handler must never become an unhandledRejection
        // (a process-killer under Bun.serve)". Observed: toHttpError's
        // in-place classification write throws on the frozen error INSIDE the
        // .catch callback, the void'd promise rejects, and the
        // unhandledRejection event fires.
        expect(
          unhandled,
          `unhandledRejection escaped the ws dispatch containment: ${unhandled
            .map((r) => String((r as Error)?.message))
            .join("; ")}`,
        ).toEqual([]);
      } finally {
        (process.off as unknown as (...args: unknown[]) => void)("unhandledRejection", onUnhandled);
      }
    },
    STEP_MS,
  );
});

// ---------------------------------------------------------------------------
// Concurrency + pooling state isolation
