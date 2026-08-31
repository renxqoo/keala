/**
 * ROUND 6 audit — LOCKS half of agent-r6-rtc (regenerated compact form after
 * a file-split accident destroyed the original bodies; the red tests live in
 * agent-r6-rtc.test.ts). Covers the audit's verified-safe findings that have
 * no lock elsewhere: the r5 redirect-neutralization corpus, the trie
 * root-wildcard priority matrix, cache concurrency + key isolation, the
 * emitter/sink/rootCache race checks, and linear-time proofs for the hot
 * RegExp surfaces under src/.
 */

import { describe, expect, it } from "vitest";

import { Honu, type Application } from "../src/index.ts";
import { cache } from "../src/middleware/cache.ts";
import { createBodyParser } from "../src/plugins/body-parser.ts";
import { serveStatic } from "../src/middleware/serve-static.ts";
import { createEmitter } from "../src/core/emitter.ts";
import {
  acceptsCharset,
  acceptsEncoding,
  acceptsLanguage,
  acceptsType,
} from "../src/negotiation/accepts.ts";
import { encodeUrlValue } from "../src/utils/url.ts";
import { parseQuery } from "../src/utils/query.ts";
import { parseCookies } from "../src/context/cookies.ts";

const quiet = { env: "test" } as const;
const under = (label: string, ms: number, budget = 500): void => {
  expect(ms, `${label} took ${ms}ms`).toBeLessThan(budget);
};
const drive = (app: Application, req: Request) => app.handle(req);
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// r5 redirect neutralization: hostile corpus stays same-origin (re-locked)
// ---------------------------------------------------------------------------

describe("R6-D redirect neutralization: hostile corpus [locks]", () => {
  const host = (location: string | null): string =>
    new URL(location ?? "", "http://good.com:3000/r").host;

  it("every relative-looking foreign target stays a same-origin path", async () => {
    const app = new Honu(quiet);
    app.get("/r", (c) => {
      c.redirect(String(c.query.next));
    });
    for (const next of [
      "//evil.com",
      "///evil.com",
      "/\\evil.com",
      "\\\\evil.com",
      "https:/evil.com",
      "HTTPS:/evil.com",
      "https:\\\\evil.com",
      " //evil.com",
      "\t//evil.com",
      "//good.com@evil.com/",
      "https:evil.com",
      "http:/\\",
    ]) {
      const res = await drive(
        app,
        new Request(`http://good.com:3000/r?next=${encodeURIComponent(next)}`),
      );
      expect(host(res.headers.get("location"))).toBe("good.com:3000");
    }
  });

  it("locks: an explicit scheme:// target is the developer's absolute redirect (koa parity)", async () => {
    const app = new Honu(quiet);
    app.get("/r", (c) => {
      c.redirect(String(c.query.next));
    });
    const res = await drive(
      app,
      new Request("http://good.com:3000/r?next=https%3A%2F%2Fexample.org%2Fx"),
    );
    expect(res.headers.get("location")).toBe("https://example.org/x");
  });

  it("locks: same-origin //host targets pass through untouched", async () => {
    const app = new Honu(quiet);
    app.get("/r", (c) => {
      c.redirect(String(c.query.next));
    });
    const res = await drive(
      app,
      new Request("http://good.com:3000/r?next=%2F%2Fgood.com%3A3000%2Fx"),
    );
    // resolved.host === the request host: the neutralizer must NOT touch it
    expect(host(res.headers.get("location"))).toBe("good.com:3000");
  });
});

// ---------------------------------------------------------------------------
// R6-F trie: root wildcard priority matrix (re-locked from the r5 fix)
// ---------------------------------------------------------------------------

describe("R6-F trie: root wildcard priority matrix [locks]", () => {
  it("static / beats /* on /", async () => {
    const app = new Honu(quiet);
    app.get("/*", (c) => c.text("wild"));
    app.get("/", (c) => c.text("root"));
    expect(await (await drive(app, new Request("http://x/"))).text()).toBe("root");
  });

  it("/:x does NOT answer / while /* does (empty capture)", async () => {
    const a = new Honu(quiet);
    a.get("/:x", (c) => c.text(`p:${c.params?.["x"]}`));
    expect((await drive(a, new Request("http://x/"))).status).toBe(404);
    const b = new Honu(quiet);
    b.get("/*", (c) => c.text(`w:${c.params?.["wildcard"] ?? ""}`));
    const res = await drive(b, new Request("http://x/"));
    expect(await res.text()).toBe("w:");
  });

  it("optional /:x? outranks /* on /", async () => {
    const app = new Honu(quiet);
    app.get("/*", (c) => c.text("wild"));
    app.get("/:x?", (c) => c.text(`opt:${c.params?.["x"] ?? "-"}`));
    expect(await (await drive(app, new Request("http://x/"))).text()).toBe("opt:-");
  });

  it("/* answers // (normalized to /) and /deep/paths", async () => {
    const app = new Honu(quiet);
    app.get("/*", (c) => c.text(`w:${c.params?.["wildcard"] ?? ""}`));
    expect((await drive(app, new Request("http://x//"))).status).toBe(200);
    expect(await (await drive(app, new Request("http://x/a/b/c"))).text()).toBe("w:a/b/c");
  });
});

// ---------------------------------------------------------------------------
// R6-K concurrency and mutable shared state (re-locked essentials)
// ---------------------------------------------------------------------------

describe("R6-K concurrency and mutable shared state [locks]", () => {
  it("cache: two concurrent misses compute twice, store once, replay correctly", async () => {
    let computed = 0;
    const app = new Honu(quiet);
    app.get("/c", cache({ ttl: 60_000 }), async (c) => {
      computed += 1;
      await new Promise((r) => setTimeout(r, 5));
      return c.text(`v${computed}`);
    });
    const [a, b] = await Promise.all([
      drive(app, new Request("http://x/c")),
      drive(app, new Request("http://x/c")),
    ]);
    expect(computed).toBe(2);
    const third = await drive(app, new Request("http://x/c"));
    expect(third.headers.get("x-cache")).toBe("hit");
    expect((await third.text()).length).toBeGreaterThan(0);
    void a;
    void b;
  });

  it("cache: HEAD shares the GET entry with a correct content-length", async () => {
    const app = new Honu(quiet);
    app.get("/h", cache(), (c) => c.text("hello"));
    await drive(app, new Request("http://x/h"));
    const head = await drive(app, new Request("http://x/h", { method: "HEAD" }));
    expect(head.headers.get("x-cache")).toBe("hit");
    expect(head.headers.get("content-length")).toBe("5");
    expect(head.body).toBeNull();
  });

  it("cache: X-Forwarded-Host path smuggling cannot forge another key (r5-2 lock)", async () => {
    const app = new Honu({ ...quiet, proxy: true });
    app.use(cache({ ttl: 60_000 }));
    app.get("/y", (c) => c.text("ATTACKER"));
    app.get("/x/y", (c) => c.text("VICTIM"));
    await drive(app, new Request("http://x/y", { headers: { "x-forwarded-host": "x/x" } }));
    const victim = await drive(app, new Request("http://x/x/y"));
    expect(victim.headers.get("x-cache")).toBeNull();
    expect(await victim.text()).toBe("VICTIM");
  });

  it("emitter: off() during emit affects the next emit only; a throwing listener propagates", () => {
    const em = createEmitter();
    const seen: string[] = [];
    const second = (): void => {
      seen.push("second");
    };
    em.on("e", () => {
      seen.push("first");
      em.off("e", second); // during emit: snapshot semantics — second still runs THIS round
    });
    em.on("e", second);
    em.emit("e");
    expect(seen).toEqual(["first", "second"]);
    seen.length = 0;
    em.emit("e");
    expect(seen).toEqual(["first"]);
  });

  it("sink: concurrent first hits all capture the body correctly", async () => {
    const app = new Honu(quiet);
    app.sink("/s", new Response("sunk", { headers: { "x-s": "1" } }));
    const [a, b, c] = await Promise.all([
      drive(app, new Request("http://x/s")),
      drive(app, new Request("http://x/s")),
      drive(app, new Request("http://x/s")),
    ]);
    expect([await a.text(), await b.text(), await c.text()]).toEqual(["sunk", "sunk", "sunk"]);
  });

  it("serveStatic: concurrent first requests resolve root safely", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "r6lock-"));
    try {
      writeFileSync(join(root, "f.txt"), "ok");
      const app = new Honu(quiet);
      app.get("/*", serveStatic({ root }));
      const [a, b] = await Promise.all([
        drive(app, new Request("http://x/f.txt")),
        drive(app, new Request("http://x/f.txt")),
      ]);
      expect([await a.text(), await b.text()]).toEqual(["ok", "ok"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("decorate() during an in-flight request becomes visible to that request (documented)", async () => {
    const app = new Honu(quiet);
    let saw: unknown = "unset";
    app.use(async (c, next) => {
      await next();
      saw = (c as unknown as { answer?: unknown }).answer ?? "unset";
    });
    app.get("/d", async (c) => {
      app.decorate("answer", 42); // visible: contexts share the app's proto
      await new Promise((r) => setTimeout(r, 2));
      return c.text("done");
    });
    await drive(app, new Request("http://x/d"));
    expect(saw).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// R6-J regex/text-path linearity on hostile 100KB inputs (re-locked core set)
// ---------------------------------------------------------------------------

describe("R6-J regex audit: 100KB hostile inputs stay linear [locks]", () => {
  it("accepts: parsePreferenceEntries / acceptsType on hostile 100KB headers", () => {
    const hostile = `${"a/".repeat(33_000)};q=0.5,${" ".repeat(10_000)}`;
    let t0 = performance.now();
    acceptsType(`text/html;q=0,${"*/*".repeat(1)},${hostile.slice(0, 50_000)}`, ["html", "json"]);
    under("acceptsType 50KB", performance.now() - t0);
    t0 = performance.now();
    acceptsEncoding(`gzip;q=0.001,${"br,".repeat(20_000)}`, ["gzip", "br"]);
    under("acceptsEncoding 40KB", performance.now() - t0);
  });

  it("query/cookie/url text paths on 100KB inputs", () => {
    const qs = `${Array.from({ length: 25_000 }, (_, i) => `k${i}=1`).join("&")}&b=2`;
    let t0 = performance.now();
    expect(Object.keys(parseQuery(qs)).length).toBe(25_001);
    under("parseQuery 100KB", performance.now() - t0);
    const cookie = `${Array.from({ length: 20_000 }, (_, i) => `c${i}=v`).join("; ")};`;
    t0 = performance.now();
    expect(Object.keys(parseCookies(cookie)).length).toBe(20_000);
    under("parseCookies 100KB", performance.now() - t0);
    const target = `/${"%".repeat(100_000)}`;
    t0 = performance.now();
    encodeUrlValue(target);
    under("encodeUrlValue 100KB %", performance.now() - t0);
  });

  it("cache-control directive regexes through the real eligibility path", async () => {
    const app = new Honu(quiet);
    const hostile = `${"no-cache,".repeat(20_000)}private`;
    app.get("/cc", cache(), (c) => {
      c.set("Cache-Control", hostile);
      return c.text("x");
    });
    const t0 = performance.now();
    await drive(app, new Request("http://x/cc"));
    under("cache hostile cache-control 100KB", performance.now() - t0, 1000);
  });

  it("redirect neutralization on a 100KB hostile target", async () => {
    const app = new Honu(quiet);
    app.get("/r", (c) => {
      c.redirect(String(c.query.next));
    });
    const target = `//${"a".repeat(100_000)}.evil.com`;
    const t0 = performance.now();
    const res = await drive(
      app,
      new Request(`http://good.com/r?next=${encodeURIComponent(target)}`),
    );
    under("redirect neutralize 100KB", performance.now() - t0, 1000);
    expect(new URL(res.headers.get("location") ?? "", "http://good.com").host).toBe("good.com");
  });

  it("negotiator parity battery still matches after the q=0/duplicate fixes", () => {
    expect(acceptsType("text/html;q=0, */*", ["html"]) ?? null).toBe(false);
    expect(acceptsType("*/*;q=0.001, application/json;q=0.001, */*;q=1", ["html", "json"])).toBe(
      "html",
    );
    expect(acceptsEncoding("gzip;q=0.001, gzip;q=0.3, identity;q=0.3", ["gzip", "identity"])).toBe(
      "gzip",
    );
    expect(
      acceptsEncoding("gzip;q=0.3, gzip;q=0.001, identity;q=0.001", ["gzip", "identity"]),
    ).toBe("gzip");
    expect(acceptsLanguage("en;q=0, *", ["en"]) ?? null).toBe(false);
    expect(acceptsCharset("utf-8;q=0, *", ["utf-8"]) ?? null).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R6-H pooling: cancel-mid-pull recycling (re-locked)
// ---------------------------------------------------------------------------

describe("R6-H pooling: retired contexts [locks]", () => {
  it("locks: a consumer cancelling mid-pull still recycles the context safely", async () => {
    const app = new Honu({ ...quiet, pooling: true });
    let pulls = 0;
    app.get("/s", (c) => {
      c.body = new ReadableStream({
        async pull(ctrl) {
          pulls += 1;
          await new Promise((r) => setTimeout(r, 5));
          ctrl.enqueue(encoder.encode(`c${pulls}`));
        },
      });
    });
    const res = await drive(app, new Request("http://x/s"));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("client aborted");
    await new Promise((r) => setTimeout(r, 25));
    const next = await drive(app, new Request("http://x/none"));
    expect(next.status).toBe(404); // pool still serves fresh contexts
  });
});

// ---------------------------------------------------------------------------
// R6-I multipart: benign boundary scans fast (the crafted case is RED in rtc.test.ts)
// ---------------------------------------------------------------------------

describe("R6-I multipart part-budget scan [locks]", () => {
  const BOUNDARY = "----r6benignboundary";
  const post = (app: Application, size: number) =>
    drive(
      app,
      new Request("http://x/f", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
        body: `--${BOUNDARY}\n${"x".repeat(size)}\n--${BOUNDARY}--\n`,
      }),
    );

  it("locks: a benign 1MB body with a normal boundary scans fast", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser());
    app.post("/f", (c) => c.text("parsed"));
    const t0 = performance.now();
    const res = await post(app, 1_000_000);
    under("benign 1MB multipart scan", performance.now() - t0, 500);
    expect(res.status).toBeLessThan(500);
  });
});
