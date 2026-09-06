/**
 * Middleware kit tests: secureHeaders, requestId, timing, logger, cors, csrf,
 * etag, compress, bodyLimit, timeout and the html escape protocol.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { cors } from "../../src/middleware/cors.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

const preflight = (
  app: { handle(r: Request): Promise<Response> },
  headers: Record<string, string>,
) =>
  app.handle(
    new Request("http://localhost:3000/x", {
      method: "OPTIONS",
      headers: { origin: "https://any.site", "access-control-request-method": "POST", ...headers },
    }),
  );

describe("cors", () => {
  it("rejects credentials:true with wildcard origin at construction", () => {
    expect(() => cors({ allowCredentials: true })).toThrow(/whitelist/);
  });

  it("reflects any origin by default; the constant '*' answer never varies", async () => {
    const app = new Keala(quiet);
    app.use(cors());
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", { headers: { origin: "https://any.site" } }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // ACAO is the constant "*" — the response is origin-independent, so
    // `Vary: Origin` would only needlessly disable shared caches.
    expect(res.headers.get("vary")).toBeNull();
  });

  it("a reflected whitelist origin always carries Vary (even without an Origin header)", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: ["https://app.site"] }));
    app.get("/x", (c) => c.text("ok"));
    const reflected = await app.handle(
      new Request("http://localhost:3000/x", { headers: { origin: "https://app.site" } }),
    );
    expect(reflected.headers.get("access-control-allow-origin")).toBe("https://app.site");
    expect(reflected.headers.get("vary")).toContain("Origin");
    // Origin-less answers must still declare the variance — the same URL
    // answers differently for an allowed origin.
    const bare = await app.handle(req("/x"));
    expect(bare.headers.get("vary")).toContain("Origin");
  });

  it("preflight answers 204 with methods and never cookies", async () => {
    const app = new Keala(quiet);
    app.use(cors({ allowHeaders: ["content-type"], maxAge: 600 }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "OPTIONS",
        headers: { origin: "https://any.site", "access-control-request-method": "GET" },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(res.headers.get("access-control-max-age")).toBe("600");
    expect(res.headers.getSetCookie().length).toBe(0);
  });

  it("whitelisted origins reflect the concrete origin with credentials", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: ["https://good.site"], allowCredentials: true }));
    app.get("/x", (c) => c.text("ok"));
    const ok = await app.handle(
      new Request("http://localhost:3000/x", { headers: { origin: "https://good.site" } }),
    );
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://good.site");
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    const bad = await app.handle(
      new Request("http://localhost:3000/x", { headers: { origin: "https://evil.site" } }),
    );
    expect(bad.status).toBe(403);
  });
});

describe("cors: origin function", () => {
  it("reflects the request origin when the predicate allows it", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: () => true }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", { headers: { origin: "https://tenant-a.site" } }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://tenant-a.site");
    // The answer is origin-dependent — the Vary invariant mirrors a whitelist.
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("rejects with 403 when the predicate denies the origin", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: () => false }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", { headers: { origin: "https://evil.site" } }),
    );
    expect(res.status).toBe(403);
    const preflightRes = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "OPTIONS",
        headers: { origin: "https://evil.site", "access-control-request-method": "GET" },
      }),
    );
    expect(preflightRes.status).toBe(403);
  });

  it("awaits async predicates (Promise<boolean>)", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: async (origin) => origin === "https://slow.site" }));
    app.get("/x", (c) => c.text("ok"));
    const ok = await app.handle(
      new Request("http://localhost:3000/x", { headers: { origin: "https://slow.site" } }),
    );
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://slow.site");
    const denied = await app.handle(
      new Request("http://localhost:3000/x", { headers: { origin: "https://other.site" } }),
    );
    expect(denied.status).toBe(403);
  });

  it("is consulted per request — multi-tenant domains each negotiate their own answer", async () => {
    const tenants = new Set(["https://a.site", "https://b.site"]);
    const app = new Keala(quiet);
    app.use(cors({ origin: (origin) => tenants.has(origin ?? "") }));
    app.get("/x", (c) => c.text("ok"));
    for (const tenant of ["https://a.site", "https://b.site"]) {
      const res = await app.handle(
        new Request("http://localhost:3000/x", { headers: { origin: tenant } }),
      );
      expect(res.headers.get("access-control-allow-origin")).toBe(tenant);
    }
    expect(
      (
        await app.handle(
          new Request("http://localhost:3000/x", { headers: { origin: "https://c.site" } }),
        )
      ).status,
    ).toBe(403);
  });

  it("origin-less requests consult the predicate with undefined and never reflect", async () => {
    const seen: (string | undefined)[] = [];
    const app = new Keala(quiet);
    app.use(
      cors({
        origin: (origin) => {
          seen.push(origin);
          return true;
        },
      }),
    );
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(req("/x"));
    expect(seen).toEqual([undefined]);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("a predicate counts as an explicit decision surface for credentials (no construction throw)", () => {
    expect(() => cors({ origin: () => true, allowCredentials: true })).not.toThrow();
  });
});

describe("cors: reflectHeaders (preflight ACRH reflection)", () => {
  it("reflects Access-Control-Request-Headers when allowHeaders is unset", async () => {
    const app = new Keala(quiet);
    app.use(cors({ reflectHeaders: true }));
    app.get("/x", (c) => c.text("ok"));
    const res = await preflight(app, { "access-control-request-headers": "x-foo, x-bar" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBe("x-foo, x-bar");
    const vary = res.headers
      .get("vary")
      ?.split(",")
      .map((token) => token.trim());
    expect(vary).toContain("Access-Control-Request-Headers");
  });

  it("is off by default — an unset allowHeaders stays unset", async () => {
    const app = new Keala(quiet);
    app.use(cors());
    app.get("/x", (c) => c.text("ok"));
    const res = await preflight(app, { "access-control-request-headers": "x-foo" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
  });

  it("an explicit allowHeaders list wins — the request list is never reflected", async () => {
    const app = new Keala(quiet);
    app.use(cors({ allowHeaders: ["content-type"], reflectHeaders: true }));
    app.get("/x", (c) => c.text("ok"));
    const res = await preflight(app, { "access-control-request-headers": "x-foo, x-bar" });
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(res.headers.get("vary")).toBeNull();
  });

  it("merges the reflected ACRH vary with the whitelist Origin vary (no duplicates)", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: ["https://app.site"], reflectHeaders: true }));
    app.get("/x", (c) => c.text("ok"));
    const res = await preflight(app, {
      origin: "https://app.site",
      "access-control-request-headers": "x-foo, x-foo",
    });
    expect(res.status).toBe(204);
    const vary = (res.headers.get("vary") ?? "").split(",").map((token) => token.trim());
    expect(new Set(vary)).toEqual(new Set(["Origin", "Access-Control-Request-Headers"]));
    expect(vary.filter((token) => token === "Origin")).toHaveLength(1);
  });

  it("a preflight without ACRH reflects nothing — no empty header, no vary", async () => {
    const app = new Keala(quiet);
    app.use(cors({ reflectHeaders: true }));
    app.get("/x", (c) => c.text("ok"));
    const res = await preflight(app, {});
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
  });
});

describe("cors: rejected preflights", () => {
  it("a disallowed preflight answers 403 by default", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: ["https://app.site"] }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "OPTIONS",
        headers: { origin: "https://evil.site", "access-control-request-method": "GET" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("a reject handler replaces the default 403", async () => {
    const app = new Keala(quiet);
    app.use(
      cors({
        origin: ["https://app.site"],
        reject: () => new Response("nope", { status: 418 }),
      }),
    );
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "OPTIONS",
        headers: { origin: "https://evil.site", "access-control-request-method": "GET" },
      }),
    );
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("nope");
  });
});
