import { describe, expect, it } from "vitest";

// globalThis.Bun is non-writable AND non-configurable on the real Bun
// runtime — these suites stub it, so they run on the Node gate only (the
// real-runtime equivalents live in scripts/smoke.ts).
const REAL_BUN = typeof Bun !== "undefined";

import { Honu, Router, createError } from "../src/index.ts";
import { acceptsEncoding } from "../src/negotiation/accepts.ts";
import { typeIs } from "../src/negotiation/typeis.ts";
import {
  charsetFromContentType,
  extensionFromMime,
  mimeFromExtension,
  normalizeType,
} from "../src/utils/mime.ts";
import { compilePattern } from "../src/router/pattern.ts";
import { createNode, insertPattern } from "../src/router/trie.ts";

describe("branch coverage: round 3", () => {
  it("identity is refused when explicitly disabled", () => {
    expect(acceptsEncoding("identity;q=0", ["identity", "gzip"])).toBe(false);
    expect(acceptsEncoding("*;q=0.0", ["identity", "gzip"])).toBe(false);
    expect(acceptsEncoding("gzip;q=0.00, identity", ["identity", "gzip"])).toBe("identity");
  });

  it("set() accepts multi-value headers", async () => {
    const app = new Honu();
    app.use(async (c) => {
      c.set("X-Multi", ["a", "b"]);
      c.body = "ok";
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("x-multi")).toBe("a, b");
  });

  it("mime helpers handle edges", () => {
    expect(normalizeType("; junk")).toBe("");
    expect(mimeFromExtension("archive.tar.gz")).toBe("application/gzip");
    expect(extensionFromMime("image/png")).toBe("png");
    expect(charsetFromContentType("")).toBe("");
  });

  it("prefers x-forwarded-host when proxying", async () => {
    const app = new Honu({ proxy: true });
    let host = "";
    app.use(async (c) => {
      host = c.host;
      c.body = "ok";
    });
    await app.handle(
      new Request("http://localhost:3000/", {
        headers: { "X-Forwarded-Host": "proxy.example.com" },
      }),
    );
    expect(host).toBe("proxy.example.com");
  });

  it.skipIf(REAL_BUN)("forwards listen options through app.listen", () => {
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    let captured: Record<string, unknown> = {};
    (globalThis as { Bun?: unknown }).Bun = {
      serve: (options: Record<string, unknown>) => {
        captured = options;
        return {
          port: options["port"],
          hostname: "localhost",
          stop() {},
          fetch: () => new Response(),
          reload() {},
        };
      },
    };
    try {
      new Honu().listen({
        port: 3999,
        reusePort: true,
        idleTimeout: 5,
        maxRequestBodySize: 777,
        development: true,
      });
      expect(captured["port"]).toBe(3999);
      expect(captured["reusePort"]).toBe(true);
      expect(captured["idleTimeout"]).toBe(5);
      expect(captured["maxRequestBodySize"]).toBe(777);
      expect(captured["development"]).toBe(true);
    } finally {
      if (originalBun === undefined) delete (globalThis as { Bun?: unknown }).Bun;
      else (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  it("typeIs tolerates garbage content types and matches xml suffixes", () => {
    expect(typeIs(";weird", [])).toBe(null);
    expect(typeIs("application/rss+xml", ["xml"])).toBe("xml");
  });

  it("keeps undecodable static segments as-is", () => {
    expect(compilePattern("/files/%E0%A4%A").segments[1]?.value).toBe("%E0%A4%A");
  });

  it("rejects conflicting param names; distinct patterns become variants", () => {
    const root = createNode();
    insertPattern(root, compilePattern("/users/:id").segments);
    expect(() => insertPattern(root, compilePattern("/users/:name").segments)).toThrow(TypeError);
    insertPattern(root, compilePattern("/users/:id(\\d+)").segments);
    // The plain head keeps its identity; the custom pattern is a variant.
    expect(root.children.get("users")?.param?.pattern).toBeNull();
    expect(root.children.get("users")?.paramMore?.[0]?.pattern?.test("7")).toBe(true);
  });

  it("url() throws when a required param is missing", () => {
    const router = new Router();
    router.get("user", "/users/:id", (c) => void c);
    expect(() => router.url("user", {})).toThrow(/Missing required parameter/);
  });

  it("createError copies headers from a wrapped error", () => {
    const inner = createError(403, "denied", { headers: { "x-inner": "1" } });
    const outer = createError(500, inner);
    expect(outer.status).toBe(403);
    expect(outer.headers).toEqual({ "x-inner": "1" });
    expect(outer.cause).toBe(inner);
  });
});
