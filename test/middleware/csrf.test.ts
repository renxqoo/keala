import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { csrfToken, csrfTokenGuard } from "../../src/middleware/csrf-token.ts";
import { csrf } from "../../src/middleware/cors.ts";

import { createHmac, randomBytes } from "node:crypto";
/**
 * csrfToken tests: issue/verify semantics on both backends (Bun.CSRF
 * natively, HMAC fallback elsewhere), tampering, expiry, session binding
 * and the request guard middleware.
 */

// globalThis.Bun is non-writable AND non-configurable on the real Bun
// runtime — these suites stub it, so they run on the Node gate only (the
// real-runtime equivalents live in scripts/smoke.ts).
const REAL_BUN = typeof Bun !== "undefined";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);
const post = (headers: Record<string, string>): Request =>
  new Request("http://localhost:3000/x", { method: "POST", headers });
const NATIVE = typeof Bun !== "undefined";

// Driving the fallback explicitly: forge/direct the HMAC format regardless
// of the running runtime, then verify through a fresh service.
const fallbackService = csrfToken({ secret: "fallback-secret" });

describe("csrfToken service", () => {
  it("round-trips issue → verify on the active backend", () => {
    const service = csrfToken({ secret: "s3cret" });
    const token = service.issue("session-1");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
    expect(service.verify(token, "session-1")).toBe(true);
  });

  it("tokens differ per issue (nonce) and never contain the secret", () => {
    const service = csrfToken({ secret: "topsecret" });
    const a = service.issue();
    const b = service.issue();
    expect(a).not.toBe(b);
    expect(a).not.toContain("topsecret");
    expect(b).not.toContain("topsecret");
  });

  it("wrong secret never verifies", () => {
    const issuer = csrfToken({ secret: "alpha" });
    const verifier = csrfToken({ secret: "beta" });
    expect(verifier.verify(issuer.issue(), undefined)).toBe(false);
  });

  it("session binding: mismatched or missing sessionId fails both ways", () => {
    const service = csrfToken({ secret: "s" });
    const bound = service.issue("user-1");
    expect(service.verify(bound, "user-1")).toBe(true);
    expect(service.verify(bound, "user-2")).toBe(false);
    expect(service.verify(bound, undefined)).toBe(false);
    const unbound = service.issue();
    expect(service.verify(unbound, "user-1")).toBe(false);
    expect(service.verify(unbound, undefined)).toBe(true);
  });

  it("expires after expiresIn", async () => {
    const service = csrfToken({ secret: "s", expiresIn: 15 });
    const token = service.issue();
    expect(service.verify(token)).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(service.verify(token)).toBe(false);
  });

  it("maxAge caps harder than the token TTL", async () => {
    const service = csrfToken({ secret: "s", expiresIn: 60_000, maxAge: 20 });
    const token = service.issue();
    expect(service.verify(token)).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(service.verify(token)).toBe(false);
    // A fresh token still verifies — only the cap rejected the old one.
    expect(service.verify(service.issue())).toBe(true);
  });

  it("malformed tokens answer false, never throw", () => {
    const service = csrfToken({ secret: "s" });
    for (const bad of [
      "",
      "garbage",
      "t1",
      "t1.only-three",
      "t1.a.b.c.d.e",
      `t1.${randomBytes(8).toString("base64url")}.abc.10000.x`,
      `t1.nonce.999999999999999999999.10000.x`,
      `t1.nonce.1234.0.x`,
      `t1.nonce.1234.-5.x`,
      "t1.".padEnd(4097, "x"),
      "\u0000\u0001",
    ]) {
      expect(service.verify(bad)).toBe(false);
    }
  });

  it.skipIf(REAL_BUN)("fallback: every signed field is tamper-evident", () => {
    const sign = (nonce: string, issuedAt: string, ttl: string): string =>
      createHmac("sha256", "fallback-secret")
        .update(`csrf1\u0000\u0000${nonce}\u0000${issuedAt}\u0000${ttl}`)
        .digest("base64url");
    const forge = (nonce: string, issuedAt: string, ttl: string): string =>
      `t1.${nonce}.${issuedAt}.${ttl}.${sign(nonce, issuedAt, ttl)}`;

    // Correct MAC under the empty session, then flip one field at a time.
    const issued = Date.now().toString();
    const base = forge("nonce", issued, "86400000");
    expect(fallbackService.verify(base)).toBe(true);
    expect(fallbackService.verify(`t1.other.${base.slice(3)}`)).toBe(false); // nonce
    expect(
      fallbackService.verify(
        `t1.nonce.${issued + "0"}.86400000.${sign("nonce", issued + "0", "86400000")}`,
      ),
    ).toBe(false); // future issue time (signed but future)
    expect(
      fallbackService.verify(`t1.nonce.${issued}.999999999.${sign("nonce", issued, "86400000")}`),
    ).toBe(false); // TTL swapped, stale MAC
    // Session swap: correct MAC for session "x", verified against "y".
    const boundMac = createHmac("sha256", "fallback-secret")
      .update(`csrf1\u0000x\u0000nonce\u0000${issued}\u000086400000`)
      .digest("base64url");
    expect(fallbackService.verify(`t1.nonce.${issued}.86400000.${boundMac}`, "y")).toBe(false);
  });

  it.skipIf(REAL_BUN)("fallback: a future-issued token is rejected without skew allowance", () => {
    const future = Date.now() + 60_000;
    const mac = createHmac("sha256", "fallback-secret")
      .update(`csrf1\u0000\u0000nonce\u0000${future}\u000086400000`)
      .digest("base64url");
    expect(fallbackService.verify(`t1.nonce.${future}.86400000.${mac}`)).toBe(false);
  });

  it.skipIf(REAL_BUN)(
    "fallback: same-secret longer-TTL cross-service tokens are rejected",
    async () => {
      const lax = csrfToken({ secret: "shared", expiresIn: 3_600_000 });
      const strict = csrfToken({ secret: "shared", expiresIn: 50 });
      const token = lax.issue();
      await new Promise((r) => setTimeout(r, 80));
      expect(strict.verify(token)).toBe(false); // TTL capped by THIS service
      expect(lax.verify(token)).toBe(true);
    },
  );

  it.skipIf(REAL_BUN)("fallback: MACs without the csrf1 domain separator never verify", () => {
    const issued = Date.now().toString();
    const foreign = createHmac("sha256", "fallback-secret")
      .update(`\u0000\u0000nonce\u0000${issued}\u000086400000`)
      .digest("base64url");
    expect(fallbackService.verify(`t1.nonce.${issued}.86400000.${foreign}`)).toBe(false);
  });

  it("throws on construction-time misconfiguration", () => {
    // @ts-expect-error -- runtime contract check for JS callers
    expect(() => csrfToken({})).toThrow(/secret/);
    expect(() => csrfToken({ secret: "" })).toThrow(/secret/);
    expect(() => csrfToken({ secret: "s", expiresIn: 0 })).toThrow(/expiresIn/);
    expect(() => csrfToken({ secret: "s", expiresIn: -1 })).toThrow(/expiresIn/);
    expect(() => csrfToken({ secret: "s", maxAge: 0 })).toThrow(/maxAge/);
    expect(() => csrfToken({ secret: "x".repeat(1025) })).toThrow(/1024/);
  });
});

describe("csrfTokenGuard middleware", () => {
  const guardedApp = (sessionId?: (c: { header(k: string): string }) => string | undefined) => {
    const service = csrfToken({ secret: "guard-secret" });
    const app = new Keala(quiet);
    app.use(csrfTokenGuard({ service, sessionId }));
    app.post("/act", (c) => c.text("done"));
    app.get("/read", (c) => c.text("done"));
    return { app, service };
  };

  it("safe methods pass without a token", async () => {
    const { app } = guardedApp();
    expect((await app.handle(req("/read"))).status).toBe(200);
    expect(
      await app.handle(new Request("http://localhost:3000/read", { method: "HEAD" })),
    ).toBeDefined();
  });

  it("a valid token lets the unsafe method through", async () => {
    const { app, service } = guardedApp();
    const res = await app.handle(
      req("/act", { method: "POST", headers: { "x-csrf-token": service.issue() } }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("done");
  });

  it("missing token → 403 with an exposed message", async () => {
    const { app } = guardedApp();
    const res = await app.handle(req("/act", { method: "POST" }));
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/missing CSRF token/);
  });

  it("invalid/expired/tampered token → 403", async () => {
    const { app, service } = guardedApp();
    const valid = service.issue();
    // Flip a MIDDLE character: on the native Bun.CSRF branch the LAST
    // base64 character can be a padding no-op (31% of tokens measured on
    // Bun 1.4.0 — flipping it leaves the MAC input bytes unchanged), which
    // made this test flaky ~1/3 of runs on the real Bun runtime.
    const mid = Math.floor(valid.length / 2);
    const flipped = valid.slice(0, mid) + (valid[mid] === "A" ? "B" : "A") + valid.slice(mid + 1);
    const cases = ["garbage", service.issue("other-session"), flipped];
    for (const token of cases) {
      const res = await app.handle(
        req("/act", { method: "POST", headers: { "x-csrf-token": token } }),
      );
      expect(res.status).toBe(403);
    }
  });

  it("sessionId resolver binds the token to the request's session", async () => {
    const cookieOf = (c: { header(k: string): string }): string | undefined =>
      c.header("cookie").match(/session=([^;]+)/)?.[1];
    const { app, service } = guardedApp(cookieOf);
    const good = req("/act", {
      method: "POST",
      headers: { cookie: "session=u1", "x-csrf-token": service.issue("u1") },
    });
    expect((await app.handle(good)).status).toBe(200);

    const stolen = req("/act", {
      method: "POST",
      headers: { cookie: "session=u2", "x-csrf-token": service.issue("u1") },
    });
    const res = await app.handle(stolen);
    expect(res.status).toBe(403);

    const sessionless = req("/act", {
      method: "POST",
      headers: { "x-csrf-token": service.issue("u1") },
    });
    expect((await app.handle(sessionless)).status).toBe(403);
  });

  it("a configured sessionId resolver yielding undefined is rejected", async () => {
    const service = csrfToken({ secret: "s" });
    const app = new Keala(quiet);
    app.use(csrfTokenGuard({ service, sessionId: () => undefined }));
    app.post("/act", (c) => c.text("done"));
    const res = await app.handle(
      req("/act", { method: "POST", headers: { "x-csrf-token": service.issue() } }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/missing session/);
  });

  it("custom header names are honored", async () => {
    const service = csrfToken({ secret: "s" });
    const app = new Keala(quiet);
    app.use(csrfTokenGuard({ service, header: "x-xsrf" }));
    app.post("/act", (c) => c.text("done"));
    const ok = await app.handle(
      req("/act", { method: "POST", headers: { "x-xsrf": service.issue() } }),
    );
    expect(ok.status).toBe(200);
    const wrongHeader = await app.handle(
      req("/act", { method: "POST", headers: { "x-csrf-token": service.issue() } }),
    );
    expect(wrongHeader.status).toBe(403);
  });

  it("throws without a service", () => {
    // @ts-expect-error -- runtime contract check for JS callers
    expect(() => csrfTokenGuard({})).toThrow(/service/);
  });
});

describe.skipIf(REAL_BUN)("csrfToken cross-backend consistency", () => {
  it("a Bun-native service and a fallback service reject each other's tokens", () => {
    if (!NATIVE) return;
    const native = csrfToken({ secret: "same" });
    const fallback = csrfToken({ secret: "same" });
    // Different MAC domains by construction; cross-verification must fail.
    expect(native.verify(fallback.issue())).toBe(false);
    expect(fallback.verify(native.issue())).toBe(false);
  });
});
describe("csrf", () => {
  it("safe methods pass without origins", async () => {
    const app = new Keala(quiet);
    app.use(csrf());
    app.get("/x", (c) => c.text("ok"));
    expect((await app.handle(req("/x"))).status).toBe(200);
  });

  it("same-origin Origin or Referer passes; cross-site and missing both reject", async () => {
    const app = new Keala(quiet);
    app.use(csrf());
    app.post("/x", (c) => c.text("ok"));
    const host = post({ origin: "http://localhost:3000" });
    expect((await app.handle(host)).status).toBe(200);
    const referer = post({ referer: "http://localhost:3000/form" });
    expect((await app.handle(referer)).status).toBe(200);
    const evil = post({ origin: "https://evil.site" });
    expect((await app.handle(evil)).status).toBe(403);
    const none = post({});
    expect((await app.handle(none)).status).toBe(403);
  });
});

describe("csrf: allow exemption hook", () => {
  it("allow → true lets an Origin-less request through (direct API calls)", async () => {
    const app = new Keala(quiet);
    app.use(csrf({ allow: () => true }));
    app.post("/x", (c) => c.text("ok"));
    const res = await app.handle(post({}));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("allow → false keeps the full Origin/Referer validation", async () => {
    const app = new Keala(quiet);
    app.use(csrf({ allow: () => false }));
    app.post("/x", (c) => c.text("ok"));
    expect((await app.handle(post({}))).status).toBe(403);
    expect((await app.handle(post({ origin: "https://evil.site" }))).status).toBe(403);
    expect((await app.handle(post({ origin: "http://localhost:3000" }))).status).toBe(200);
  });

  it("allow may be async (Promise<boolean>)", async () => {
    const app = new Keala(quiet);
    app.use(csrf({ allow: async (c) => c.header("authorization").length > 0 }));
    app.post("/x", (c) => c.text("ok"));
    const bearer = post({ authorization: "Bearer t" });
    expect((await app.handle(bearer)).status).toBe(200);
    const anonymous = post({});
    expect((await app.handle(anonymous)).status).toBe(403);
  });

  it("allow receives the request context — the authenticated-API pattern", async () => {
    const seen: string[] = [];
    const app = new Keala(quiet);
    app.use(
      csrf({
        allow: (c) => {
          seen.push(`${c.method} ${c.path}`);
          return c.header("authorization").length > 0;
        },
      }),
    );
    app.post("/api/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/api/x", {
        method: "POST",
        headers: { authorization: "Bearer t" },
      }),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual(["POST /api/x"]);
  });

  it("the hook is consulted BEFORE Origin/Referer validation — same-origin is never affected", async () => {
    const calls: number[] = [];
    const app = new Keala(quiet);
    app.use(
      csrf({
        allow: (c) => {
          calls.push(1);
          return c.header("authorization").length > 0;
        },
      }),
    );
    app.post("/x", (c) => c.text("ok"));
    app.get("/read", (c) => c.text("ok"));
    // A cross-site request WITH an exempting header bypasses the 403 — the
    // hook's answer wins over the origin verdict, by design.
    const exempt = post({ origin: "https://evil.site", authorization: "Bearer t" });
    expect((await app.handle(exempt)).status).toBe(200);
    // Safe methods never consult the hook (they were never checked).
    expect((await app.handle(req("/read"))).status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
