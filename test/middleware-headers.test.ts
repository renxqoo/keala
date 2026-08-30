/**
 * Middleware kit tests: secureHeaders, requestId, timing, logger, cors, csrf,
 * etag, compress, bodyLimit, timeout and the html escape protocol.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import { secureHeaders, requestId, timing, logger } from "../src/middleware/headers.ts";
import { cors, csrf } from "../src/middleware/cors.ts";
import { etag, compress } from "../src/middleware/etag.ts";
import { bodyLimit, timeout } from "../src/middleware/limits.ts";
import { html, raw, escapeHtml } from "../src/helpers/html.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("secureHeaders", () => {
  it("sets the safe defaults", async () => {
    const app = createApp(quiet);
    app.use(secureHeaders());
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("HSTS is opt-in with extras", async () => {
    const app = createApp(quiet);
    app.use(secureHeaders({ hsts: 31536000, hstsExtras: ["includeSubDomains"] }));
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});

describe("requestId", () => {
  it("generates ids and echoes them", async () => {
    const app = createApp(quiet);
    app.use(requestId());
    app.get("/x", (c) => {
      c.set("X-State-Id", String(c.state.requestId ?? ""));
      c.body = "ok";
    });
    const res = await app.handle(req("/x"));
    const id = res.headers.get("x-request-id");
    expect(id).not.toBeNull();
    expect(res.headers.get("x-state-id")).toBe(id);
  });

  it("honors valid inbound ids and replaces garbage", async () => {
    const app = createApp(quiet);
    app.use(requestId());
    app.get("/x", (c) => c.text("ok"));
    const kept = await app.handle(
      new Request("http://localhost:3000/x", { headers: { "x-request-id": "abc-123" } }),
    );
    expect(kept.headers.get("x-request-id")).toBe("abc-123");
    const replaced = await app.handle(
      new Request("http://localhost:3000/x", { headers: { "x-request-id": "bad id with spaces" } }),
    );
    expect(replaced.headers.get("x-request-id")).not.toBe("bad id with spaces");
  });
});

describe("timing + logger", () => {
  it("Server-Timing carries total and named marks", async () => {
    const app = createApp(quiet);
    app.use(timing());
    app.get("/x", async (c) => {
      (c.state as { timingMark?: (n: string) => void }).timingMark?.("db");
      c.body = "ok";
    });
    const res = await app.handle(req("/x"));
    const value = res.headers.get("server-timing") ?? "";
    expect(value).toContain("total;dur=");
    expect(value).toContain("db;dur=");
  });

  it("logger writes one structured line per request", async () => {
    const lines: string[] = [];
    const app = createApp(quiet);
    app.use(logger({ write: (line) => lines.push(line) }));
    app.get("/x", (c) => c.text("ok"));
    await app.handle(req("/x"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^GET \/x -> 200 \d+ms -$/);
  });
});

describe("cors", () => {
  it("rejects credentials:true with wildcard origin at construction", () => {
    expect(() => cors({ allowCredentials: true })).toThrow(/whitelist/);
  });

  it("reflects any origin by default; the constant '*' answer never varies", async () => {
    const app = createApp(quiet);
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
    const app = createApp(quiet);
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
    const app = createApp(quiet);
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
    const app = createApp(quiet);
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

describe("csrf", () => {
  const post = (headers: Record<string, string>): Request =>
    new Request("http://localhost:3000/x", { method: "POST", headers });

  it("safe methods pass without origins", async () => {
    const app = createApp(quiet);
    app.use(csrf());
    app.get("/x", (c) => c.text("ok"));
    expect((await app.handle(req("/x"))).status).toBe(200);
  });

  it("same-origin Origin or Referer passes; cross-site and missing both reject", async () => {
    const app = createApp(quiet);
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

describe("etag + compress", () => {
  it("tags state bodies weakly and answers 304 on If-None-Match", async () => {
    const app = createApp(quiet);
    app.use(etag());
    app.get("/x", (c) => {
      c.body = "stable-body";
    });
    const first = await app.handle(req("/x"));
    const tag = first.headers.get("etag");
    expect(tag).toMatch(/^W\//);
    const second = await app.handle(
      new Request("http://localhost:3000/x", { headers: { "if-none-match": tag ?? "" } }),
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("compress skips tiny bodies but still varies", async () => {
    const app = createApp(quiet);
    app.use(compress());
    app.get("/x", (c) => {
      c.body = "tiny";
    });
    const res = await app.handle(
      new Request("http://localhost:3000/x", { headers: { "accept-encoding": "gzip" } }),
    );
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});

describe("bodyLimit + timeout", () => {
  it("bodyLimit rejects declared oversize with 413 before reading", async () => {
    const app = createApp(quiet);
    app.use(bodyLimit(10));
    app.post("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "POST",
        body: "0".repeat(64),
        headers: { "content-length": "64" },
      }),
    );
    expect(res.status).toBe(413);
  });

  it("bodyLimit validates its argument", () => {
    expect(() => bodyLimit(-1)).toThrow(TypeError);
  });

  it("timeout expires into an exposed 504; fast paths pass", async () => {
    const app = createApp(quiet);
    app.get("/slow", timeout(10), async () => {
      await new Promise((r) => setTimeout(r, 60));
      return new Response("late");
    });
    const res = await app.handle(req("/slow"));
    expect(res.status).toBe(504);
    app.get("/fast", timeout(1000), (c) => c.text("fast"));
    expect((await app.handle(req("/fast"))).status).toBe(200);
    expect(() => timeout(0)).toThrow(TypeError);
  });
});

describe("html escape protocol", () => {
  it("escapes interpolations and honors raw()", () => {
    const user = '<script>alert("x")</script>';
    expect(html`<b>${user}</b>`).toBe("<b>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</b>");
    expect(html`<b>${raw(user)}</b>`).toBe(`<b>${user}</b>`);
    expect(escapeHtml("&<'\">")).toBe("&amp;&lt;&#39;&quot;&gt;");
  });

  it("flattens arrays and stringifies primitives; null vanishes", () => {
    expect(html`${[1, "a", raw("<i>")]}!`).toBe("1a<i>!");
    expect(html`x${null}${undefined}y`).toBe("xy");
  });
});

describe("cors: rejected preflights", () => {
  it("a disallowed preflight answers 403 by default", async () => {
    const app = createApp(quiet);
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
    const app = createApp(quiet);
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
