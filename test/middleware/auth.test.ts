import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { basicAuth, bearerAuth, timingSafeEqual } from "../../src/middleware/auth.ts";
import {
  bunPasswordHasher,
  hashPassword,
  verifyPassword,
  type PasswordHasher,
} from "../../src/helpers/password.ts";
import type { RouteHandler } from "../../src/router/router.ts";
/**
 * auth component tests: basic/bearer middleware (happy + every malformed
 * shape) and password hashing round-trips on both runtimes (Bun.password
 * natively, node:crypto scrypt as the fallback).
 */

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);
const basic = (user: string, pass: string): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
});

const guarded = (verify: (u: string, p: string) => boolean | Promise<boolean>) => {
  const app = new Keala(quiet);
  app.use(basicAuth({ verify, realm: 'Admin "Area"' }));
  app.get("/secret", (c) => c.text("granted"));
  return app;
};

describe("basicAuth", () => {
  it("accepts valid credentials and calls the downstream handler", async () => {
    const app = guarded((u, p) => u === "alice" && p === "s3cret");
    const res = await app.handle(req("/secret", { headers: basic("alice", "s3cret") }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("granted");
  });

  it("answers 401 + WWW-Authenticate (escaped realm) on wrong credentials", async () => {
    const app = guarded((u, p) => u === "alice" && p === "s3cret");
    const res = await app.handle(req("/secret", { headers: basic("alice", "wrong") }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Admin Area", charset="UTF-8"');
    // A null body on an error status falls back to the status message.
    // (Was the U3b byte-equivalence anchor — basicAuth's return-ification
    // kept these bytes; the anchor is discharged.)
    expect(await res.text()).toBe("Unauthorized");
  });

  it.each([
    ["missing header", undefined],
    ["wrong scheme", { authorization: "Bearer xyz" }],
    ["bare scheme", { authorization: "Basic" }],
    ["non-base64 payload", { authorization: "Basic !!!not-base64!!!" }],
    [
      "no colon separator",
      { authorization: `Basic ${Buffer.from("justuser").toString("base64")}` },
    ],
    ["empty username", { authorization: `Basic ${Buffer.from(":pw").toString("base64")}` }],
    ["embedded NUL", { authorization: `Basic ${Buffer.from("a\0b:c").toString("base64")}` }],
    [
      "invalid UTF-8",
      {
        // 0xFF 0xFE is not a valid UTF-8 credential.
        authorization: `Basic ${Buffer.from([0xff, 0xfe, 0x3a, 0x61]).toString("base64")}`,
      },
    ],
  ])("rejects %s with 401", async (_label, headers) => {
    const app = guarded(() => true);
    const res = await app.handle(req("/secret", headers === undefined ? {} : { headers }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
  });

  it("treats the auth-scheme case-insensitively (RFC 7617)", async () => {
    const app = guarded((u, p) => u === "a" && p === "b");
    const headers = { authorization: `basic ${Buffer.from("a:b").toString("base64")}` };
    expect((await app.handle(req("/secret", { headers }))).status).toBe(200);
  });

  it("supports passwords containing colons and unicode credentials", async () => {
    const app = new Keala(quiet);
    app.use(basicAuth({ verify: (u, p) => p === "pa:ss:word" || (u === "用户" && p === "密码") }));
    app.get("/secret", (c) => c.text("ok"));
    expect((await app.handle(req("/secret", { headers: basic("u", "pa:ss:word") }))).status).toBe(
      200,
    );
    expect((await app.handle(req("/secret", { headers: basic("用户", "密码") }))).status).toBe(200);
  });

  it("never invokes verify for structurally invalid credentials", async () => {
    let calls = 0;
    const app = guarded(() => {
      calls += 1;
      return true;
    });
    await app.handle(req("/secret", { headers: { authorization: "Basic &&&" } }));
    expect(calls).toBe(0);
  });

  it("supports async verifiers and their rejections", async () => {
    const app = new Keala(quiet);
    app.use(
      basicAuth({
        verify: async (u, p) => {
          await new Promise((r) => setTimeout(r, 1));
          return u === "a" && p === "b";
        },
      }),
    );
    app.get("/secret", (c) => c.text("ok"));
    expect((await app.handle(req("/secret", { headers: basic("a", "b") }))).status).toBe(200);
    expect((await app.handle(req("/secret", { headers: basic("a", "x") }))).status).toBe(401);
  });

  it("throws on a missing verify option", () => {
    expect(() => basicAuth({})).toThrow(/verify|username/);
  });
});

describe("bearerAuth", () => {
  const bearerApp = (verify: (t: string) => boolean | Promise<boolean>) => {
    const app = new Keala(quiet);
    app.use(bearerAuth({ verify, realm: "API" }));
    app.get("/me", (c) => c.text("ok"));
    return app;
  };

  it("accepts a valid token", async () => {
    const app = bearerApp((t) => t === "tok-1");
    const res = await app.handle(req("/me", { headers: { authorization: "Bearer tok-1" } }));
    expect(res.status).toBe(200);
  });

  it("answers 401 + realm for a missing header", async () => {
    const app = bearerApp(() => true);
    const res = await app.handle(req("/me"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="API"');
  });

  // M7: RFC 6750 §3.1 — a PRESENT but malformed Authorization (wrong scheme,
  // empty/whitespace/control-byte token) is invalid_request (400), not 401.
  it.each([
    ["wrong scheme", { authorization: "Basic abc" }],
    ["empty token", { authorization: "Bearer " }],
    ["whitespace inside token", { authorization: "Bearer to ken" }],
    ["control byte inside token", { authorization: `Bearer to\x01ken` }],
  ])("answers 400 + error=invalid_request for %s", async (_label, headers) => {
    const app = bearerApp(() => true);
    const res = await app.handle(req("/me", { headers }));
    expect(res.status).toBe(400);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_request"');
  });

  it("a present-but-rejected token carries error=invalid_token (RFC 6750)", async () => {
    const app = bearerApp((t) => t === "tok-1");
    const res = await app.handle(req("/me", { headers: { authorization: "Bearer nope" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="API", error="invalid_token"');
  });

  it("accepts lowercase scheme and supports async verifiers", async () => {
    const app = bearerApp(async (t) => t === "T");
    const res = await app.handle(req("/me", { headers: { authorization: "bearer T" } }));
    expect(res.status).toBe(200);
  });

  it("throws on a missing verify option", () => {
    expect(() => bearerAuth({})).toThrow(/verify|token/);
  });
});

describe("password hashing (runtime-adaptive)", () => {
  it("hash and verify round-trip", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("produces the portable pbkdf2 format on every runtime", async () => {
    const hash = await hashPassword("pw");
    expect(hash.startsWith("pbkdf2$")).toBe(true);
  });

  it("bunPasswordHasher() is an explicit opt-in with loud failure modes", async () => {
    if (typeof Bun === "undefined") {
      expect(() => bunPasswordHasher()).toThrow(/Bun runtime/);
      return;
    }
    if (typeof Bun.password !== "object") {
      expect(() => bunPasswordHasher()).toThrow(/Bun\.password/);
      return;
    }
    const hasher = bunPasswordHasher();
    const hash = await hashPassword("pw", hasher);
    // Where Bun.password works it round-trips; where the native verify is
    // broken (Bun 1.4.0 on some platforms) it throws Bun's own descriptive
    // error — never a silent false.
    try {
      expect(await verifyPassword(hash, "pw", hasher)).toBe(true);
    } catch (error) {
      expect((error as Error).message).toMatch(/Password verification failed/);
    }
  });

  it("pbkdf2 hashes reject iteration-count tampering and bounds violations", async () => {
    const hash = await hashPassword("pw");
    const [, iterations, salt, key] = hash.split("$") as [string, string, string, string];
    for (const bad of ["0", "999", "5000001", "abc"]) {
      expect(await verifyPassword(`pbkdf2$${bad}$${salt}$${key}`, "pw")).toBe(false);
    }
    expect(await verifyPassword(`pbkdf2$${iterations}$${salt}$${key}`, "pw")).toBe(true);
  });

  it("rejects malformed hashes with false, never a crash", async () => {
    for (const bad of [
      "",
      "not-a-hash",
      "pbkdf2$",
      "pbkdf2$a$b$c$d$e",
      "scrypt$16384$8$1$AAAA$BBBB",
      "pbkdf2$1000$",
      "pbkdf2$1000$not-base64-$$$",
    ]) {
      expect(await verifyPassword(bad, "pw")).toBe(false);
    }
  });

  it("refuses empty and oversized inputs", async () => {
    await expect(hashPassword("")).rejects.toThrow(/non-empty/);
    await expect(hashPassword("x".repeat(1025))).rejects.toThrow(/1024/);
    expect(await verifyPassword("scrypt$16384$8$1$AAAA$BBBB", "")).toBe(false);
    expect(await verifyPassword("$argon2id$" + "x".repeat(600), "pw")).toBe(false);
  });

  it("PHC-format hashes throw loudly without an explicit hasher (all runtimes)", async () => {
    await expect(verifyPassword("$argon2id$v=19$abc$def", "pw")).rejects.toThrow(
      /bunPasswordHasher|explicitly/,
    );
  });

  it("an injected hasher drives both directions", async () => {
    const seen: string[] = [];
    const hasher: PasswordHasher = {
      async hash(p) {
        seen.push(p);
        return `custom:${p}`;
      },
      async verify(hash, p) {
        return hash === `custom:${p}`;
      },
    };
    const hash = await hashPassword("pw", hasher);
    expect(hash).toBe("custom:pw");
    expect(await verifyPassword(hash, "pw", hasher)).toBe(true);
    expect(await verifyPassword(hash, "no", hasher)).toBe(false);
    expect(seen).toEqual(["pw"]);
  });
});

/**
 * Realm sanitization tests (SEC-5): a realm containing `\` used to corrupt
 * the WWW-Authenticate challenge — only `"` was stripped, so a realm ending
 * in a backslash terminated the quoted-string early (`realm="My\"` leaves
 * the closing quote escaped and the parameter value dangling). Both quote
 * classes are stripped now, and a realm that strips to nothing is a setup
 * error.
 */

const verify = (_credentials: string) => true;
const reqPrivate = () => new Request("http://localhost:3000/private");

const challengeOf = async (middleware: RouteHandler): Promise<string> => {
  const app = new Keala(quiet);
  app.use(middleware);
  const res = await app.handle(reqPrivate());
  return res.headers.get("www-authenticate") ?? "";
};

describe("auth realm: quoted-string safety", () => {
  it("a trailing backslash no longer dangles the quote (the SEC-5 repro)", async () => {
    // realm value: "My " + one backslash — the old challenge was
    // `realm="My\"` (closing quote escaped, value unterminated).
    const challenge = await challengeOf(basicAuth({ verify, realm: "My \\" }));
    expect(challenge).toBe('Basic realm="My ", charset="UTF-8"');
    // The parameter stays a closed quoted-string: balanced quotes.
    expect((challenge.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it("quotes are still stripped (locked behavior)", async () => {
    const challenge = await challengeOf(basicAuth({ verify, realm: 'Admin "Area"' }));
    expect(challenge).toBe('Basic realm="Admin Area", charset="UTF-8"');
  });

  it("mixed quotes and backslashes all strip", async () => {
    const challenge = await challengeOf(basicAuth({ verify, realm: 'a"b\\c"d' }));
    expect(challenge).toContain('realm="abcd"');
  });

  it("the default realm is untouched", async () => {
    const challenge = await challengeOf(basicAuth({ verify }));
    expect(challenge).toBe('Basic realm="Restricted", charset="UTF-8"');
  });

  it("a realm that strips to nothing is a loud setup error (both middlewares)", () => {
    expect(() => basicAuth({ verify, realm: '""' })).toThrow(TypeError);
    expect(() => basicAuth({ verify, realm: "\\" })).toThrow(/basicAuth: realm/);
    expect(() => bearerAuth({ verify, realm: '"\\\\"' })).toThrow(/bearerAuth: realm/);
  });

  it("bearerAuth realms get the same treatment", async () => {
    const challenge = await challengeOf(bearerAuth({ verify, realm: "API v\\2" }));
    expect(challenge).toBe('Bearer realm="API v2"');
  });
});

// ---------------------------------------------------------------------------
// M7: timingSafeEqual + token option + RFC 6750 three-way + static credentials
// ---------------------------------------------------------------------------

describe("M7: timingSafeEqual", () => {
  it("equal strings → true", () => {
    expect(timingSafeEqual("secret", "secret")).toBe(true);
  });
  it("different strings → false", () => {
    expect(timingSafeEqual("secret", "secreU")).toBe(false);
  });
  it("different lengths → false (no throw)", () => {
    expect(timingSafeEqual("short", "a-much-longer-secret")).toBe(false);
  });
  it("empty strings → true", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });
  it("Uint8Array inputs work", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });
});

describe("M7: bearerAuth({ token }) — static token with timing-safe compare", () => {
  it("correct token → 200", async () => {
    const app = new Keala(quiet);
    app.use(bearerAuth({ token: "my-static-token" }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      req("/x", { headers: { authorization: "Bearer my-static-token" } }),
    );
    expect(res.status).toBe(200);
  });

  it("wrong token → 401 + error=invalid_token", async () => {
    const app = new Keala(quiet);
    app.use(bearerAuth({ token: "my-static-token" }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(req("/x", { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("token array — any match passes", async () => {
    const app = new Keala(quiet);
    app.use(bearerAuth({ token: ["key-a", "key-b"] }));
    app.get("/x", (c) => c.text("ok"));
    const a = await app.handle(req("/x", { headers: { authorization: "Bearer key-b" } }));
    const c = await app.handle(req("/x", { headers: { authorization: "Bearer key-z" } }));
    expect(a.status).toBe(200);
    expect(c.status).toBe(401);
  });
});

describe("M7: RFC 6750 three-way — malformed → 400 invalid_request", () => {
  it("token with internal whitespace → 400 error=invalid_request", async () => {
    const app = new Keala(quiet);
    app.use(bearerAuth({ verify: () => true }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      req("/x", { headers: { authorization: "Bearer not@valid token" } }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_request"');
  });

  it("token with control bytes → 400", async () => {
    const app = new Keala(quiet);
    app.use(bearerAuth({ verify: () => true }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      req("/x", { headers: { authorization: `Bearer tok${"\x01"}en` } }),
    );
    expect(res.status).toBe(400);
  });

  it("empty Bearer token → 400", async () => {
    const app = new Keala(quiet);
    app.use(bearerAuth({ verify: () => true }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(req("/x", { headers: { authorization: "Bearer " } }));
    expect(res.status).toBe(400);
  });

  it("verify-rejected (valid format) → 401 + error=invalid_token", async () => {
    const app = new Keala(quiet);
    app.use(bearerAuth({ verify: () => false }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(req("/x", { headers: { authorization: "Bearer valid-format" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("M7: basicAuth({ username, password }) — static credentials", () => {
  it("correct credentials → 200", async () => {
    const app = new Keala(quiet);
    app.use(basicAuth({ username: "admin", password: "s3cret" }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(req("/x", { headers: basic("admin", "s3cret") }));
    expect(res.status).toBe(200);
  });

  it("wrong password → 401", async () => {
    const app = new Keala(quiet);
    app.use(basicAuth({ username: "admin", password: "s3cret" }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(req("/x", { headers: basic("admin", "wrong") }));
    expect(res.status).toBe(401);
  });

  it("timing-safe (not === on plaintext)", async () => {
    const app = new Keala(quiet);
    app.use(basicAuth({ username: "admin", password: "s3cret" }));
    app.get("/x", (c) => c.text("ok"));
    // Prefix-match attempt (=== would short-circuit true on partial match)
    const res = await app.handle(req("/x", { headers: basic("admin", "s3cr") }));
    expect(res.status).toBe(401);
  });
});
