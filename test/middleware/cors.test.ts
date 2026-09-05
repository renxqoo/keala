/**
 * Middleware kit tests: secureHeaders, requestId, timing, logger, cors, csrf,
 * etag, compress, bodyLimit, timeout and the html escape protocol.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { cors } from "../../src/middleware/cors.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

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
