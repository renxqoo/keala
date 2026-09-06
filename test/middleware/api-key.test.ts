import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { bearerAuth } from "../../src/middleware/auth.ts";
import { apiKeyAuth, type ApiKeyAuthOptions } from "../../src/middleware/api-key.ts";
import { some } from "../../src/middleware/combine.ts";
/**
 * apiKeyAuth component tests: X-API-Key guard — static keys (timing-safe),
 * verify callbacks (sync + async), the RFC 6750-style three-way (missing →
 * 401, malformed → 400, rejected → 401), custom header names, and the
 * multi-auth composition with some().
 */

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

const guarded = (options: ApiKeyAuthOptions) => {
  const app = new Keala(quiet);
  app.use(apiKeyAuth(options));
  app.get("/me", (c) => c.text("granted"));
  return app;
};

describe("apiKeyAuth — static keys", () => {
  it("accepts a listed key and calls the downstream handler", async () => {
    const app = guarded({ keys: ["key-1", "key-2"], realm: "API" });
    const res = await app.handle(req("/me", { headers: { "x-api-key": "key-1" } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("granted");
  });

  it("any key in the array passes; an unlisted one is rejected", async () => {
    const app = guarded({ keys: ["key-1", "key-2"] });
    const ok = await app.handle(req("/me", { headers: { "x-api-key": "key-2" } }));
    const bad = await app.handle(req("/me", { headers: { "x-api-key": "key-z" } }));
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(401);
  });

  it("a single string key is accepted as a one-element list", async () => {
    const app = guarded({ keys: "solo-key" });
    expect((await app.handle(req("/me", { headers: { "x-api-key": "solo-key" } }))).status).toBe(
      200,
    );
    expect((await app.handle(req("/me", { headers: { "x-api-key": "solo" } }))).status).toBe(401);
  });

  it("rejects a wrong key with 401 + error=invalid_token", async () => {
    const app = guarded({ keys: ["key-1"], realm: "API" });
    const res = await app.handle(req("/me", { headers: { "x-api-key": "nope" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('ApiKey realm="API", error="invalid_token"');
  });

  it("is timing-safe: a matching prefix of a valid key is still rejected", async () => {
    const app = guarded({ keys: ["key-123456"] });
    // A === comparison would also reject the prefix, but a length-blind one
    // would not; timingSafeEqual compares every byte and the length differs.
    const res = await app.handle(req("/me", { headers: { "x-api-key": "key-1" } }));
    expect(res.status).toBe(401);
  });
});

describe("apiKeyAuth — three-way challenge (RFC 6750 spirit)", () => {
  it("a missing header answers 401 + ApiKey realm challenge (no error param)", async () => {
    const app = guarded({ keys: ["key-1"], realm: "API" });
    const res = await app.handle(req("/me"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('ApiKey realm="API"');
  });

  it("an empty header value is indistinguishable from absent → 401", async () => {
    const app = guarded({ keys: ["key-1"] });
    const res = await app.handle(req("/me", { headers: { "x-api-key": "" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('ApiKey realm="Restricted"');
  });

  it("a whitespace-only key is normalized away by fetch headers → 401", async () => {
    const app = guarded({ keys: ["key-1"] });
    // "   " never reaches the middleware: the headers parser strips
    // surrounding OWS, so it is indistinguishable from an absent header.
    const res = await app.handle(req("/me", { headers: { "x-api-key": "   " } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('ApiKey realm="Restricted"');
  });

  it.each([
    ["key with internal whitespace", "key 1"],
    ["key with a control byte", "key\x011"],
    ["oversized key (over 8192)", "k".repeat(8193)],
  ])("answers 400 + error=invalid_request for %s", async (_label, key) => {
    const app = guarded({ keys: ["key-1"] });
    const res = await app.handle(req("/me", { headers: { "x-api-key": key } }));
    expect(res.status).toBe(400);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_request"');
  });

  it("never invokes verify for structurally invalid keys", async () => {
    let calls = 0;
    const app = guarded({
      verify: () => {
        calls += 1;
        return true;
      },
    });
    await app.handle(req("/me", { headers: { "x-api-key": "bad key" } }));
    expect(calls).toBe(0);
  });
});

describe("apiKeyAuth — verify callbacks", () => {
  it("sync verify accepts and rejects", async () => {
    const app = guarded({ verify: (key) => key === "db-key" });
    expect((await app.handle(req("/me", { headers: { "x-api-key": "db-key" } }))).status).toBe(200);
    expect((await app.handle(req("/me", { headers: { "x-api-key": "other" } }))).status).toBe(401);
  });

  it("async verify works (the database-lookup shape)", async () => {
    const seen: string[] = [];
    const app = guarded({
      verify: async (key) => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(key);
        return key.startsWith("live-");
      },
    });
    const ok = await app.handle(req("/me", { headers: { "x-api-key": "live-42" } }));
    const bad = await app.handle(req("/me", { headers: { "x-api-key": "dead-42" } }));
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(401);
    expect(seen).toEqual(["live-42", "dead-42"]);
  });
});

describe("apiKeyAuth — configuration", () => {
  it("supports a custom header name, looked up case-insensitively", async () => {
    const app = guarded({ keys: ["key-1"], header: "X-Services-Key" });
    const ok = await app.handle(req("/me", { headers: { "X-SERVICES-KEY": "key-1" } }));
    const missing = await app.handle(req("/me", { headers: { "x-api-key": "key-1" } }));
    expect(ok.status).toBe(200);
    expect(missing.status).toBe(401);
  });

  it("strips quotes and backslashes from the realm (quoted-string safety)", async () => {
    const app = guarded({ keys: ["key-1"], realm: 'Admin "Area"\\' });
    const res = await app.handle(req("/me"));
    expect(res.headers.get("www-authenticate")).toBe('ApiKey realm="Admin Area"');
  });

  it("throws on a missing keys/verify option", () => {
    expect(() => apiKeyAuth({})).toThrow(/verify|keys/);
  });

  it("throws on an empty header name (loud setup error, not a silent 401-all)", () => {
    expect(() => apiKeyAuth({ keys: ["k"], header: "" })).toThrow(/header/);
  });

  it("a realm that strips to nothing is a loud setup error", () => {
    expect(() => apiKeyAuth({ keys: ["k"], realm: '"\\' })).toThrow(/apiKeyAuth: realm/);
  });
});

describe("apiKeyAuth + some() — multi-auth", () => {
  it("either a bearer token or an API key admits the request", async () => {
    const app = new Keala(quiet);
    app.use(some(bearerAuth({ token: "tok-1" }), apiKeyAuth({ keys: ["key-1"] })));
    app.get("/me", (c) => c.text("ok"));
    const bearer = await app.handle(req("/me", { headers: { authorization: "Bearer tok-1" } }));
    const apiKey = await app.handle(req("/me", { headers: { "x-api-key": "key-1" } }));
    const neither = await app.handle(req("/me"));
    expect(bearer.status).toBe(200);
    expect(apiKey.status).toBe(200);
    expect(neither.status).toBe(401);
  });
});
