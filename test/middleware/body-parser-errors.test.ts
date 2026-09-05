/**
 * DOGFOOD-R2 — contract locks for the second consumer's feedback round
 * (docs/DOGFOOD-R2.md; source: Tillgate's Hono→keala migration on 0.5.1).
 * C1 body-reader fast paths keep their LIMIT semantics, C2 extends the dev
 * no-next warning to route-scoped middleware positions, C4 exports the
 * middleware vocabulary and machine-readable error codes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { createBodyParser, readBodyLimited } from "../../src/index.ts";
import { bodyOf } from "../../src/plugins/body-parser.ts";
import type { Next, RouteHandler } from "../../src/index.ts";
import { isHttpError } from "../../src/index.ts";

const quiet = { env: "test" } as const;

/** Route-scoped middleware that returns void and never calls next(). */
const stall = async (c: { state: Record<string, unknown> }): Promise<void> => {
  c.state["touched"] = true;
};

const warnSpy = (): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(console, "warn").mockImplementation(() => {});
const req = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost:3000${path}`, {
    ...init,
    ...(init?.body instanceof ReadableStream ? { duplex: "half" as const } : null),
  });

/** A body stream that delivers `chunks` then ends. */
const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Run one readBodyLimited against a fresh request, inside a real context. */
const readViaApp = async (
  request: Request,
  limit: number,
): Promise<{ out?: Uint8Array; error?: unknown }> => {
  const app = new Keala(quiet);
  let result: { out?: Uint8Array; error?: unknown } = {};
  app.post("/x", async (c) => {
    try {
      result = { out: await readBodyLimited(c, limit) };
    } catch (error) {
      result = { error };
    }
    return c.text("done");
  });
  await app.handle(request);
  return result;
};

// ---------------------------------------------------------------------------
// C1 — readBodyLimited fast paths keep the limit contract.
// ---------------------------------------------------------------------------

describe("C1: readBodyLimited declared-length fast path", () => {
  it("reads a declared body into one preallocated buffer (exact length)", async () => {
    const body = bytes('{"model":"bench"}');
    const res = await readViaApp(
      req("/x", {
        method: "POST",
        body: streamOf([body]),
        headers: { "content-length": String(body.byteLength) },
      }),
      1024,
    );
    expect(res.error).toBeUndefined();
    expect(new TextDecoder().decode(res.out as Uint8Array)).toBe('{"model":"bench"}');
    expect((res.out as Uint8Array).byteLength).toBe(body.byteLength);
  });

  it("reassembles a multi-chunk declared body without concatenation copies", async () => {
    const res = await readViaApp(
      req("/x", {
        method: "POST",
        body: streamOf([bytes("hello "), bytes("world")]),
        headers: { "content-length": "11" },
      }),
      1024,
    );
    expect(new TextDecoder().decode(res.out as Uint8Array)).toBe("hello world");
  });

  it("a declared length over the limit fails fast with 413 before reading", async () => {
    const res = await readViaApp(
      req("/x", {
        method: "POST",
        body: streamOf([bytes("x")]),
        headers: { "content-length": "64" },
      }),
      16,
    );
    expect(isHttpError(res.error)).toBe(true);
    expect((res.error as { status: number }).status).toBe(413);
  });

  it("a lying declared length that busts the limit still 413s mid-read", async () => {
    const res = await readViaApp(
      req("/x", {
        method: "POST",
        body: streamOf([bytes("0123456789")]),
        headers: { "content-length": "2" },
      }),
      4,
    );
    expect(isHttpError(res.error)).toBe(true);
    expect((res.error as { status: number }).status).toBe(413);
  });

  it("a lying declared length WITHIN the limit returns the real bytes", async () => {
    const res = await readViaApp(
      req("/x", {
        method: "POST",
        body: streamOf([bytes("0123456789")]),
        headers: { "content-length": "4" },
      }),
      64,
    );
    expect(new TextDecoder().decode(res.out as Uint8Array)).toBe("0123456789");
  });

  it("a truncated stream (fewer bytes than declared) yields the delivered bytes", async () => {
    const res = await readViaApp(
      req("/x", {
        method: "POST",
        body: streamOf([bytes("hi")]),
        headers: { "content-length": "10" },
      }),
      1024,
    );
    expect(new TextDecoder().decode(res.out as Uint8Array)).toBe("hi");
  });
});

describe("C1: readBodyLimited chunked (no declared length) path", () => {
  it("counts streamed bytes and 413s past the boundary", async () => {
    const res = await readViaApp(
      req("/x", { method: "POST", body: streamOf([bytes("aaaa"), bytes("bbbb")]) }),
      6,
    );
    expect(isHttpError(res.error)).toBe(true);
    expect((res.error as { status: number }).status).toBe(413);
  });

  it("a single-chunk body returns without a reassembly copy", async () => {
    const res = await readViaApp(
      req("/x", { method: "POST", body: streamOf([bytes("single")]) }),
      1024,
    );
    expect(new TextDecoder().decode(res.out as Uint8Array)).toBe("single");
  });

  it("an empty body yields zero bytes", async () => {
    const res = await readViaApp(req("/x", { method: "POST", body: streamOf([]) }), 1024);
    expect((res.out as Uint8Array).byteLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C4 — machine-readable codes on the body-reader errors.
// ---------------------------------------------------------------------------

describe("C4: body errors carry machine-readable codes", () => {
  const parser = createBodyParser({ jsonLimit: 8 });
  const appWith = () => {
    const app = new Keala(quiet);
    app.use(parser);
    app.post("/x", async (c) => {
      try {
        return c.json(await bodyOf(c).json());
      } catch (error) {
        if (isHttpError(error)) return c.json({ code: error.code ?? null }, error.status as 400);
        throw error;
      }
    });
    return app;
  };

  it("malformed JSON answers 400 with code invalid_json", async () => {
    const res = await appWith().handle(
      req("/x", { method: "POST", body: "{nope", headers: { "content-type": "application/json" } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "invalid_json" });
  });

  it("over-limit answers 413 with code payload_too_large", async () => {
    const res = await appWith().handle(
      req("/x", {
        method: "POST",
        body: '{"a":"xxxxxxxxxxxxxxxx"}',
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: "payload_too_large" });
  });

  it("Next and RouteHandler are importable from the root entry (type-level)", () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping -- local on purpose: proves the type composition
    const mw: RouteHandler = async (_c, next: Next) => {
      await next();
    };
    expect(typeof mw).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// C2 — dev warning when route-scoped middleware stalls the chain (void,
// no next, no response) — the silent-404 trap from the migration round.
// ---------------------------------------------------------------------------

describe("C2: dev warning for route-scoped middleware that never calls next", () => {
  const warns = warnSpy;
  afterEach(() => vi.restoreAllMocks());

  it("warns once (deduped) and answers 404 — the migration trap", async () => {
    const warn = warns();
    const app = new Keala({ env: "development" });
    let handlerRan = false;
    app.post("/body", stall, (c) => {
      handlerRan = true;
      return c.json({ ok: true });
    });

    const res = await app.handle(req("/body", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404); // the silent failure itself
    expect(handlerRan).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("POST");
    expect(message).toContain("/body");
    expect(message).toContain("next");

    await app.handle(req("/body", { method: "POST", body: "{}" }));
    expect(warn).toHaveBeenCalledTimes(1); // deduped
  });

  it("covers Router.use (prefix middleware) positions too", async () => {
    const warn = warns();
    const { Router } = await import("../../src/index.ts");
    const app = new Keala({ env: "development" });
    const api = new Router();
    api.use((_c) => {
      // void, no next — stalls every route in the group
    });
    api.get("/things", (c) => c.json({ ok: true }));
    app.mount("/api", api);

    const res = await app.handle(req("/api/things"));
    expect(res.status).toBe(404);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn when the terminal handler returns void (contract 404)", async () => {
    const warn = warns();
    const app = new Keala({ env: "development" });
    app.get("/empty", () => {
      // intentionally produces nothing — untouched → notFound is the contract
    });
    const res = await app.handle(req("/empty"));
    expect(res.status).toBe(404);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when the middleware answers with a Response without next", async () => {
    const warn = warns();
    const app = new Keala({ env: "development" });
    app.get(
      "/x",
      (c) => {
        // U3c: the return form is the only answer shape — no next is legit
        // whenever a Response is returned (the old state-mode twin).
        return c.text("from middleware");
      },
      (c) => c.json({ never: true }),
    );
    const res = await app.handle(req("/x"));
    expect(await res.text()).toBe("from middleware");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when the middleware throws (intentional rejection)", async () => {
    const warn = warns();
    const app = new Keala({ env: "development" });
    app.get(
      "/x",
      (c) => {
        c.throw(400, "bad input");
      },
      (c) => c.json({ never: true }),
    );
    const res = await app.handle(req("/x"));
    expect(res.status).toBe(400);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent in test/production environments", async () => {
    const warn = warns();
    const app = new Keala({ env: "production" });
    app.get("/x", stall as never, (c) => c.json({ ok: true }));
    await app.handle(req("/x"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("the global-position swallow keeps its own (C4/DOGFOOD-R1) warning", async () => {
    const warn = warns();
    const app = new Keala({ env: "development" });
    app.use(() => {
      // global middleware, void, no next, no response
    });
    app.get("/health", (c) => c.text("ok"));
    const res = await app.handle(req("/health"));
    expect(res.status).toBe(404);
    expect(warn).toHaveBeenCalledTimes(1); // exactly one — not double-reported
    expect(String(warn.mock.calls[0]?.[0])).toContain("/health");
  });
});
