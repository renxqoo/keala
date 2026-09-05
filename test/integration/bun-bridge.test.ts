/**
 * Native-bridge coverage: the `typeof Bun` detection points (Bun.file
 * bodies, Bun.password detection, Bun.CSRF wrapping) never execute under
 * the Node test runner — these tests stub the Bun global BEFORE importing
 * the modules so each bridge is exercised on both runtimes.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Every test here stubs globalThis.Bun — impossible on the real Bun runtime
// (non-writable, non-configurable global). The Node gate runs this file in
// full; the real-runtime equivalents live in scripts/smoke.ts.
const REAL_BUN = typeof Bun !== "undefined";

import { Keala } from "../../src/core/app.ts";
import { streamSSE, disableIdleTimeout } from "../../src/helpers/streams.ts";
import type { Context } from "../../src/core/context/context.ts";

const quiet = { env: "test" } as const;

type BunShape = Record<string, unknown>;
const withBun = async <T>(shape: BunShape, run: () => Promise<T> | T): Promise<T> => {
  const globalScope = globalThis as { Bun?: unknown };
  const original = globalScope.Bun;
  globalScope.Bun = shape;
  vi.resetModules();
  try {
    return await run();
  } finally {
    if (original === undefined) delete globalScope.Bun;
    else globalScope.Bun = original;
    vi.resetModules();
  }
};

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bk-bridge-"));
  await writeFile(join(root, "a.txt"), "zero-copy body");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(REAL_BUN)("serve-static × Bun.file body", () => {
  it("serves file bodies through Bun.file when the runtime provides it", async () => {
    await withBun(
      {
        file: (path: string): Blob => new Blob([readFileSync(path)]),
      },
      async () => {
        const { serveStatic } = await import("../../src/middleware/serve-static.ts");
        const app = new Keala(quiet);
        app.get("/f/*", serveStatic({ root, prefix: "/f" }));
        const res = await app.handle(new Request("http://localhost:3000/f/a.txt"));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("zero-copy body");
      },
    );
  });
});

describe.skipIf(REAL_BUN)("auth × Bun.password detection", () => {
  it("ignores a malformed Bun.password shape and uses the portable pbkdf2 default", async () => {
    await withBun({ password: { hash: "not-a-function" } }, async () => {
      const { hashPassword, verifyPassword } = await import("../../src/helpers/password.ts");
      const hash = await hashPassword("pw");
      expect(hash.startsWith("pbkdf2$")).toBe(true);
      expect(await verifyPassword(hash, "pw")).toBe(true);
    });
    await withBun({ password: "string-not-object" }, async () => {
      const { hashPassword } = await import("../../src/helpers/password.ts");
      expect((await hashPassword("pw")).startsWith("pbkdf2$")).toBe(true);
    });
  });

  it("uses Bun.password when explicitly injected and well-formed", async () => {
    const hashes: string[] = [];
    await withBun(
      {
        password: {
          hash: async (pw: string) => {
            hashes.push(pw);
            return `stubbed:${pw}`;
          },
          verify: async (hash: string, pw: string) => hash === `stubbed:${pw}`,
        },
      },
      async () => {
        const { hashPassword, verifyPassword, bunPasswordHasher } =
          await import("../../src/helpers/password.ts");
        const native = bunPasswordHasher();
        const hash = await hashPassword("pw", native);
        expect(hash).toBe("stubbed:pw");
        expect(await verifyPassword(hash, "pw", native)).toBe(true);
        expect(await verifyPassword(hash, "other", native)).toBe(false);
        expect(hashes).toEqual(["pw"]);
      },
    );
  });

  it("bunPasswordHasher() reports malformed Bun.password shapes loudly", async () => {
    await withBun({ password: { hash: () => "x" } }, async () => {
      const { bunPasswordHasher } = await import("../../src/helpers/password.ts");
      expect(() => bunPasswordHasher()).toThrow(/malformed Bun\.password/);
    });
    await withBun({ password: "string-not-object" }, async () => {
      const { bunPasswordHasher } = await import("../../src/helpers/password.ts");
      expect(() => bunPasswordHasher()).toThrow(/requires Bun\.password/);
    });
  });

  it("a failing WebCrypto derive makes verification fail closed, not throw", async () => {
    const { pbkdf2PasswordHasher } = await import("../../src/helpers/password.ts");
    const realCrypto = globalThis.crypto;
    const broken = {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      subtle: {
        importKey: async () => {
          throw new Error("broken provider");
        },
        deriveBits: realCrypto.subtle.deriveBits.bind(realCrypto.subtle),
      },
    };
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    // `crypto` is accessor-only on some runtimes — redefine as a data
    // property (getter descriptors cannot carry a value).
    Object.defineProperty(globalThis, "crypto", {
      value: broken,
      writable: true,
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
    });
    try {
      // Well-formed hash string; derivation fails inside verify().
      const hash =
        "pbkdf2$600000$" +
        Buffer.from("0123456789abcdef").toString("base64") +
        "$" +
        Buffer.from("k".repeat(32)).toString("base64");
      expect(await pbkdf2PasswordHasher().verify(hash, "pw")).toBe(false);
    } finally {
      if (descriptor !== undefined) Object.defineProperty(globalThis, "crypto", descriptor);
    }
  });
});

describe.skipIf(REAL_BUN)("csrfToken × Bun.CSRF wrapping", () => {
  it("delegates issue/verify with the full option set and short-circuits garbage", async () => {
    const generateCalls: unknown[] = [];
    const verifyCalls: unknown[] = [];
    await withBun(
      {
        CSRF: {
          generate: (secret: string, options: Record<string, unknown>) => {
            generateCalls.push({ secret, options });
            return `native-token-${generateCalls.length}`;
          },
          verify: (token: string, options: Record<string, unknown>) => {
            verifyCalls.push({ token, options });
            return token === "native-token-1";
          },
        },
      },
      async () => {
        const { csrfToken } = await import("../../src/middleware/csrf-token.ts");
        const service = csrfToken({
          secret: "s",
          expiresIn: 5000,
          maxAge: 3000,
          algorithm: "sha512",
        });
        const token = service.issue("u1");
        expect(token).toBe("native-token-1");
        expect(generateCalls).toEqual([
          { secret: "s", options: { sessionId: "u1", expiresIn: 5000, algorithm: "sha512" } },
        ]);
        expect(service.verify(token, "u1")).toBe(true);
        expect(service.verify("garbage", "u1")).toBe(false);
        expect(service.verify("", "u1")).toBe(false);
        // Empty short-circuits locally; other garbage is the native
        // verifier's call (it fails closed on unknown formats itself).
        expect(verifyCalls).toEqual([
          {
            token: "native-token-1",
            options: {
              secret: "s",
              sessionId: "u1",
              maxAge: 3000,
              algorithm: "sha512",
            },
          },
          {
            token: "garbage",
            options: {
              secret: "s",
              sessionId: "u1",
              maxAge: 3000,
              algorithm: "sha512",
            },
          },
        ]);
      },
    );
  });

  it("a malformed Bun.CSRF shape falls back to the HMAC implementation", async () => {
    await withBun({ CSRF: { generate: () => "x" } }, async () => {
      const { csrfToken } = await import("../../src/middleware/csrf-token.ts");
      const service = csrfToken({ secret: "s" });
      expect(service.verify(service.issue())).toBe(true);
      expect(service.issue().startsWith("t1.")).toBe(true);
    });
  });

  it("an unbound native issue passes no sessionId key at all", async () => {
    const generateCalls: unknown[] = [];
    await withBun(
      {
        CSRF: {
          generate: (_s: string, options: Record<string, unknown>) => {
            generateCalls.push(options);
            return "t";
          },
          verify: () => true,
        },
      },
      async () => {
        const { csrfToken } = await import("../../src/middleware/csrf-token.ts");
        csrfToken({ secret: "s" }).issue();
        expect(generateCalls).toEqual([{ expiresIn: 86_400_000, algorithm: "sha256" }]);
      },
    );
  });
});

describe("streamSSE × server.timeout bridge", () => {
  it("streamSSE disables the per-request idle timeout when a server rides the runtime", async () => {
    const timeouts: Array<{ request: Request; seconds: number }> = [];
    const app = new Keala(quiet);
    app.get("/events", (c) =>
      streamSSE(c, (sse) => {
        sse.send({ data: "hi" });
      }),
    );
    const request = new Request("http://localhost:3000/events");
    const res = await app.handle(request, {
      server: {
        timeout: (req: Request, seconds: number) => timeouts.push({ request: req, seconds }),
      },
    });
    expect(res.status).toBe(200);
    expect(timeouts).toEqual([{ request, seconds: 0 }]);
  });

  it("disableIdleTimeout is a no-op without a server handle", () => {
    const c = { runtime: undefined, raw: new Request("http://localhost/") } as unknown as Context;
    expect(() => disableIdleTimeout(c)).not.toThrow();
    const silent = {
      runtime: { server: {} },
      raw: new Request("http://localhost/"),
    } as unknown as Context;
    expect(() => disableIdleTimeout(silent)).not.toThrow();
  });
});
