/**
 * Agent3 — core pipeline bug hunt (TDD red tests).
 *
 * Targets: finalize's untouched/committed branches (src/core/respond.ts),
 * the response sugar helpers (src/core/context/response.ts) and their
 * interaction with staged state and the dual-mode commit rule.
 *
 * Every CONFIRMED-BUG test asserts the CORRECT observable behavior and fails
 * against the current src/. Cleared probes are kept at the bottom as
 * regression coverage for behaviors that are already correct.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("agent3 — finalize: synthesized responses drop staged headers", () => {
  // Root cause: src/core/respond.ts finalize() untouched branch — the 405/
  // 501/OPTIONS synthesis (methodNotAllowed) builds a fresh Response from
  // `{ allow }` only, and a notFound handler's returned Response is sent
  // verbatim; neither consults c.headersRecord. Staged writes survive the
  // untouched check because c.set() only raises flag 4, not flag 1.
  // Expected (koa contract, cf. app.test.ts "global middleware runs for
  // UNMATCHED paths"): middleware headers reach the client on every response.
  it("CONFIRMED-BUG: 405 synthesis drops headers staged by global middleware", async () => {
    const app = createApp(quiet);
    app.use(async (c, next) => {
      c.set("X-Tag", "1");
      await next();
    });
    app.post("/only", (c) => c.text("post"));
    const res = await app.handle(req("/only", { method: "DELETE" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("x-tag")).toBe("1");
  });

  it("CONFIRMED-BUG: notFound returning a Response drops staged headers", async () => {
    const app = createApp(quiet);
    app.use(async (c, next) => {
      c.set("X-Tag", "1");
      await next();
    });
    app.notFound(() => new Response("nothing", { status: 404 }));
    const res = await app.handle(req("/nope"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-tag")).toBe("1");
  });
});

describe("agent3 — post-commit response rewrites are dropped", () => {
  // Root cause: src/core/respond.ts finalize() — the committed fast path
  // returns `committed` as-is and mergeIntoCommitted() rebuilds with
  // `status: res.status`, so a state-mode `c.status` write made after
  // `await next()` never reaches the wire (the getter was made commit-aware,
  // the setter is silently lost).
  it("CONFIRMED-BUG: c.status write after next() never reaches the response", async () => {
    const app = createApp(quiet);
    app.use(async (c, next) => {
      await next();
      c.status = 201;
    });
    app.get("/x", (c) => c.text("made"));
    const res = await app.handle(req("/x"));
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("made");
  });

  it("CONFIRMED-BUG: c.status write after next() is dropped on the merge path too", async () => {
    const app = createApp(quiet);
    app.use(async (c, next) => {
      await next();
      c.status = 203;
      c.set("X-Late", "1");
    });
    app.get("/x", () => new Response("ok"));
    const res = await app.handle(req("/x"));
    expect(res.status).toBe(203);
    expect(res.headers.get("x-late")).toBe("1");
  });

  // Root cause: src/core/context/response.ts append() stores a FIRST single
  // value as a plain string with no append marker; src/core/respond.ts
  // mergeIntoCommitted() then applies staged strings via `headers.set()`,
  // replacing the committed Response's own value instead of appending to it.
  it("CONFIRMED-BUG: c.append after next() replaces the committed header", async () => {
    const app = createApp(quiet);
    app.use(async (c, next) => {
      await next();
      c.append("X-Many", "b");
    });
    app.get("/x", () => new Response("ok", { headers: { "x-many": "a" } }));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("x-many")).toBe("a, b");
  });

  it("CONFIRMED-BUG: c.append Set-Cookie after next() drops the committed cookie", async () => {
    const app = createApp(quiet);
    app.use(async (c, next) => {
      await next();
      c.append("Set-Cookie", "outer=1; Path=/");
    });
    app.get("/x", () => new Response("ok", { headers: { "set-cookie": "inner=1; Path=/" } }));
    const res = await app.handle(req("/x"));
    expect(res.headers.getSetCookie().sort()).toEqual(["inner=1; Path=/", "outer=1; Path=/"]);
  });

  // Root cause: src/core/context/response.ts remove() only deletes from the
  // (empty) staging record; src/core/respond.ts finalize() takes the
  // committed fast path whenever `countOf(record) > 0` is false — a removal
  // leaves no record entries, so the committed header is sent unchanged.
  it("CONFIRMED-BUG: c.remove after next() is a silent no-op on a committed Response", async () => {
    const app = createApp(quiet);
    app.use(async (c, next) => {
      await next();
      c.remove("X-Secret");
    });
    app.get("/x", () => new Response("ok", { headers: { "x-secret": "data" } }));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("x-secret")).toBe(null);
  });
});

describe("agent3 — sugar helpers vs staged state", () => {
  // Root cause: src/core/context/response.ts text()/json()/html() build the
  // Response directly. With a null-body status (204/205/304) the fetch
  // `Response` constructor rejects a non-null body (undici: "Invalid response
  // status code 204"), so the TypeError escapes the handler and the error
  // path answers an opaque 500 — while the state-mode equivalent
  // (`c.status = 204; c.body = "done"`) is cleaned to an empty 204 by
  // fromState's empty-status contract.
  it("CONFIRMED-BUG: c.text with an explicit 204 status answers an opaque 500", async () => {
    const app = createApp(quiet);
    app.get("/a", (c) => c.text("done", 204));
    const res = await app.handle(req("/a"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("CONFIRMED-BUG: staged 204 status + c.text answers an opaque 500", async () => {
    const app = createApp(quiet);
    app.get("/b", (c) => {
      c.status = 204;
      return c.text("done");
    });
    const res = await app.handle(req("/b"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  // Root cause: src/core/context/response.ts text()/json()/html() consume the
  // staged status but never pass `statusText: this.messageValue`, so a staged
  // c.message is silently discarded — fromState() would have honored it
  // (cf. test/response.test.ts "status message" via the state path).
  it("CONFIRMED-BUG: sugar helpers drop a staged c.message (statusText lost)", async () => {
    const app = createApp(quiet);
    app.get("/x", (c) => {
      c.message = "all good";
      return c.text("ok");
    });
    const res = await app.handle(req("/x"));
    expect(res.statusText).toBe("all good");
  });
});

describe("agent3 — investigated and cleared", () => {
  it("clear: error headers with array values all reach the response", async () => {
    const app = createApp(quiet);
    app.get("/e", (c) => {
      c.throw(400, "nope", { headers: { "retry-after": ["1", "2"] } });
    });
    const res = await app.handle(req("/e"));
    expect(res.status).toBe(400);
    expect(res.headers.get("retry-after")).toBe("1, 2");
  });

  it("clear: HEAD on an expose 4xx error backfills content-length", async () => {
    const app = createApp(quiet);
    app.get("/e", (c) => {
      c.throw(418, "teapot");
    });
    const res = await app.handle(req("/e", { method: "HEAD" }));
    expect(res.status).toBe(418);
    expect(res.headers.get("content-length")).toBe("6");
    expect(await res.text()).toBe("");
  });

  it("clear: circular body answers a clean 500, not a rejection", async () => {
    const app = createApp(quiet);
    app.get("/c", (c) => {
      const o: Record<string, unknown> = {};
      o["self"] = o;
      c.body = o;
    });
    const res = await app.handle(req("/c"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it("clear: a throwing onerror listener still answers the static 500", async () => {
    const app = createApp(quiet);
    app.onError(() => {
      throw new Error("listener boom");
    });
    app.get("/x", () => {
      throw new Error("handler boom");
    });
    const res = await app.handle(req("/x"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it("clear: HEAD on a committed Response backfills content-length", async () => {
    const app = createApp(quiet);
    app.get("/x", () => new Response("committed-body"));
    const res = await app.handle(req("/x", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("14");
    expect(await res.text()).toBe("");
  });
});
