/**
 * auth component tests: basic/bearer middleware (happy + every malformed
 * shape) and password hashing round-trips on both runtimes (Bun.password
 * natively, node:crypto scrypt as the fallback).
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import {
  basicAuth,
  bearerAuth,
  hashPassword,
  verifyPassword,
  type PasswordHasher,
} from "../src/components/auth.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);
const basic = (user: string, pass: string): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
});

const guarded = (verify: (u: string, p: string) => boolean | Promise<boolean>) => {
  const app = createApp(quiet);
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
    // koa parity: a null body on an error status falls back to the message.
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
    const app = createApp(quiet);
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
    const app = createApp(quiet);
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
    // @ts-expect-error -- runtime contract check for JS callers
    expect(() => basicAuth({})).toThrow(/verify/);
  });
});

describe("bearerAuth", () => {
  const bearerApp = (verify: (t: string) => boolean | Promise<boolean>) => {
    const app = createApp(quiet);
    app.use(bearerAuth({ verify, realm: "API" }));
    app.get("/me", (c) => c.text("ok"));
    return app;
  };

  it("accepts a valid token", async () => {
    const app = bearerApp((t) => t === "tok-1");
    const res = await app.handle(req("/me", { headers: { authorization: "Bearer tok-1" } }));
    expect(res.status).toBe(200);
  });

  it.each([
    ["missing header", undefined],
    ["wrong scheme", { authorization: "Basic abc" }],
    ["empty token", { authorization: "Bearer " }],
    ["whitespace inside token", { authorization: "Bearer to ken" }],
    ["control byte inside token", { authorization: `Bearer to\x01ken` }],
  ])("answers 401 + realm for %s", async (_label, headers) => {
    const app = bearerApp(() => true);
    const res = await app.handle(req("/me", headers === undefined ? {} : { headers }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="API"');
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
    // @ts-expect-error -- runtime contract check for JS callers
    expect(() => bearerAuth({})).toThrow(/verify/);
  });
});

describe("password hashing (runtime-adaptive)", () => {
  it("hash and verify round-trip", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("produces the runtime-native format (argon2 on Bun, scrypt elsewhere)", async () => {
    const hash = await hashPassword("pw");
    if (typeof Bun !== "undefined") {
      expect(hash.startsWith("$argon2")).toBe(true);
    } else {
      expect(hash.startsWith("scrypt$")).toBe(true);
    }
  });

  it("scrypt fallback hashes verify under Bun too (cross-format)", async () => {
    if (typeof Bun === "undefined") return; // fallback IS the default here
    const scryptOnly: PasswordHasher = {
      async hash(password) {
        return `scrypt$16384$8$1$${Buffer.from("salt").toString("base64")}$${Buffer.from(password).toString("base64")}`;
      },
      async verify() {
        return false;
      },
    };
    const hash = await hashPassword("pw", scryptOnly);
    expect(await verifyPassword(hash, "pw")).toBe(true);
    expect(await verifyPassword(hash, "other")).toBe(false);
  });

  it("rejects malformed hashes with false, never a crash", async () => {
    const corrupt = ["", "not-a-hash", "scrypt$", "scrypt$a$b$c$d$e", "scrypt$x$1$1$AAAA$BBBB"];
    if (typeof Bun !== "undefined") corrupt.push("$argon2id$garbage");
    for (const bad of corrupt) {
      expect(await verifyPassword(bad, "pw")).toBe(false);
    }
  });

  it("refuses empty and oversized inputs", async () => {
    await expect(hashPassword("")).rejects.toThrow(/non-empty/);
    await expect(hashPassword("x".repeat(1025))).rejects.toThrow(/1024/);
    expect(await verifyPassword("scrypt$16384$8$1$AAAA$BBBB", "")).toBe(false);
    expect(await verifyPassword("$argon2id$" + "x".repeat(600), "pw")).toBe(false);
  });

  it("argon2 hashes under Node without Bun.password throw loudly, not false", async () => {
    if (typeof Bun !== "undefined") return;
    await expect(verifyPassword("$argon2id$v=19$abc$def", "pw")).rejects.toThrow(/Bun\.password/);
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
