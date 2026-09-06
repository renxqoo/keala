/**
 * Middleware kit tests: secureHeaders, requestId, timing, logger, cors, csrf,
 * etag, compress, bodyLimit, timeout and the html escape protocol.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { secureHeaders, requestId, timing, logger } from "../../src/middleware/headers.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("secureHeaders", () => {
  it("sets the safe defaults", async () => {
    const app = new Keala(quiet);
    app.use(secureHeaders());
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("HSTS is opt-in with extras", async () => {
    const app = new Keala(quiet);
    app.use(secureHeaders({ hsts: 31536000, hstsExtras: ["includeSubDomains"] }));
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("hsts: false is an explicit off (same as the default)", async () => {
    const app = new Keala(quiet);
    app.use(secureHeaders({ hsts: false, hstsExtras: ["includeSubDomains"] }));
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M5 — CSP, nonce, Permissions-Policy, COOP/COEP/CORP, per-header toggles
// ---------------------------------------------------------------------------

describe("secureHeaders — CSP", () => {
  it("ships the safe default-src 'self' policy when unconfigured", async () => {
    const app = new Keala(quiet);
    app.use(secureHeaders());
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
  });

  it("passes a custom policy string through verbatim", async () => {
    const app = new Keala(quiet);
    app.use(secureHeaders({ csp: "default-src 'none'; img-src 'self' data:" }));
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src 'self' data:",
    );
  });

  it("csp: false disables the policy header entirely", async () => {
    const app = new Keala(quiet);
    app.use(secureHeaders({ csp: false }));
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("content-security-policy")).toBeNull();
    // The static guards stay on — CSP is independently switchable.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("cspReportOnly emits the report-only variant only when given a string", async () => {
    const report = "default-src 'self'; report-uri /csp-report";
    const app = new Keala(quiet);
    app.use(secureHeaders({ cspReportOnly: report }));
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("content-security-policy-report-only")).toBe(report);
    // Report-only never replaces the enforcing default policy.
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
    const off = new Keala(quiet);
    off.use(secureHeaders({ cspReportOnly: false }));
    off.get("/x", (c) => c.text("x"));
    expect(
      (await off.handle(req("/x"))).headers.get("content-security-policy-report-only"),
    ).toBeNull();
  });
});

describe("secureHeaders — nonce", () => {
  it("injects the callback's value as a quoted nonce source and exposes c.state.cspNonce", async () => {
    const app = new Keala(quiet);
    app.use(
      secureHeaders({
        csp: "default-src 'self'; script-src 'self' {nonce}",
        nonce: () => "deadbeef",
      }),
    );
    app.get("/x", (c) => c.text(String(c.state.cspNonce ?? "missing")));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self' 'nonce-deadbeef'",
    );
    // The handler saw the nonce BEFORE it rendered — one value everywhere.
    expect(await res.text()).toBe("deadbeef");
  });

  it("calls the nonce callback with the request context, once per request", async () => {
    const seen: string[] = [];
    const app = new Keala(quiet);
    app.use(
      secureHeaders({
        csp: "default-src 'self'",
        nonce: (c) => {
          seen.push(`${c.method} ${c.path}`);
          return `n-${seen.length}`;
        },
      }),
    );
    app.get("/x", (c) => c.text("ok"));
    await app.handle(req("/x"));
    expect(seen).toEqual(["GET /x"]);
  });

  it("still exposes cspNonce when the policy has no {nonce} placeholder", async () => {
    const app = new Keala(quiet);
    app.use(secureHeaders({ csp: "default-src 'self'", nonce: () => "plain" }));
    app.get("/x", (c) => c.text(String(c.state.cspNonce ?? "missing")));
    const res = await app.handle(req("/x"));
    expect(await res.text()).toBe("plain");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
  });
});

describe("secureHeaders — per-header toggles", () => {
  it("string overrides replace the default value", async () => {
    const app = new Keala(quiet);
    app.use(
      secureHeaders({
        xFrameOptions: "SAMEORIGIN",
        xContentTypeOptions: "nosniff",
        referrerPolicy: "strict-origin-when-cross-origin",
        xDnsPrefetchControl: "on",
        xXssProtection: "1; mode=block",
      }),
    );
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-dns-prefetch-control")).toBe("on");
    expect(res.headers.get("x-xss-protection")).toBe("1; mode=block");
  });

  it("false turns each guard off independently", async () => {
    const app = new Keala(quiet);
    app.use(
      secureHeaders({
        csp: false,
        xFrameOptions: false,
        xContentTypeOptions: false,
        referrerPolicy: false,
        xDnsPrefetchControl: false,
        xXssProtection: false,
        crossOriginOpenerPolicy: false,
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: false,
        permittedCrossDomainPolicies: false,
      }),
    );
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    for (const name of [
      "content-security-policy",
      "x-frame-options",
      "x-content-type-options",
      "referrer-policy",
      "x-dns-prefetch-control",
      "x-xss-protection",
      "cross-origin-opener-policy",
      "cross-origin-embedder-policy",
      "cross-origin-resource-policy",
      "x-permitted-cross-domain-policies",
    ]) {
      expect(res.headers.get(name), `${name} should be off`).toBeNull();
    }
  });

  it("X-XSS-Protection: 0 and X-DNS-Prefetch-Control: off ship by default", async () => {
    const app = new Keala(quiet);
    app.use(secureHeaders());
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    // 0 disables the legacy auditor (it actively mangled pages).
    expect(res.headers.get("x-xss-protection")).toBe("0");
    expect(res.headers.get("x-dns-prefetch-control")).toBe("off");
  });

  it("a handler-set header is never stomped by the middleware defaults", async () => {
    const app = new Keala(quiet);
    app.use(secureHeaders());
    app.get("/x", (c) => {
      c.setHeader("X-Frame-Options", "SAMEORIGIN");
      c.setHeader("Content-Security-Policy", "default-src https://cdn.example");
      c.setHeader("Referrer-Policy", "unsafe-url");
      return c.text("ok");
    });
    const res = await app.handle(req("/x"));
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("content-security-policy")).toBe("default-src https://cdn.example");
    expect(res.headers.get("referrer-policy")).toBe("unsafe-url");
  });

  it("a header baked into a returned Response also wins", async () => {
    const app = new Keala(quiet);
    app.use(secureHeaders());
    app.get(
      "/x",
      () =>
        new Response("ok", {
          status: 200,
          headers: { "x-frame-options": "ALLOW-FROM http://embed.example" },
        }),
    );
    const res = await app.handle(req("/x"));
    expect(res.headers.get("x-frame-options")).toBe("ALLOW-FROM http://embed.example");
    // Untouched names still get the defaults.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("secureHeaders — COOP / COEP / CORP", () => {
  it("COOP and CORP default to same-origin; COEP stays off", async () => {
    const app = new Keala(quiet);
    app.use(secureHeaders());
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    // COEP require-corp breaks any page embedding cross-origin resources, so
    // it is opt-in only.
    expect(res.headers.get("cross-origin-embedder-policy")).toBeNull();
  });

  it("custom strings apply and false disables", async () => {
    const app = new Keala(quiet);
    app.use(
      secureHeaders({
        crossOriginOpenerPolicy: "same-origin-allow-popups",
        crossOriginEmbedderPolicy: "require-corp",
        crossOriginResourcePolicy: "cross-origin",
      }),
    );
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
    expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");

    const off = new Keala(quiet);
    off.use(
      secureHeaders({
        crossOriginOpenerPolicy: false,
        crossOriginResourcePolicy: false,
      }),
    );
    off.get("/x", (c) => c.text("x"));
    const offRes = await off.handle(req("/x"));
    expect(offRes.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(offRes.headers.get("cross-origin-resource-policy")).toBeNull();
  });
});

describe("secureHeaders — Permissions-Policy", () => {
  it("builds the directive list from the allowlists", async () => {
    const app = new Keala(quiet);
    app.use(
      secureHeaders({
        permissionsPolicy: {
          camera: [],
          geolocation: ["self"],
          fullscreen: ["*"],
          microphone: ["none"],
          payment: ["self", "https://pay.example.com"],
          displayCapture: ["self"],
        },
      }),
    );
    app.get("/x", (c) => c.text("x"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("permissions-policy")).toBe(
      "camera=(), geolocation=(self), fullscreen=*, microphone=(), " +
        'payment=(self "https://pay.example.com"), display-capture=(self)',
    );
  });

  it("is absent unless configured, and false disables it", async () => {
    const plain = new Keala(quiet);
    plain.use(secureHeaders());
    plain.get("/x", (c) => c.text("x"));
    expect((await plain.handle(req("/x"))).headers.get("permissions-policy")).toBeNull();

    const off = new Keala(quiet);
    off.use(secureHeaders({ permissionsPolicy: false }));
    off.get("/x", (c) => c.text("x"));
    expect((await off.handle(req("/x"))).headers.get("permissions-policy")).toBeNull();
  });
});

describe("secureHeaders — error path coverage", () => {
  it("a thrown handler's error page still carries CSP and the guards", async () => {
    const app = new Keala(quiet);
    app.use(
      secureHeaders({
        csp: "default-src 'self'",
        crossOriginEmbedderPolicy: "require-corp",
      }),
    );
    app.get("/e", (c) => {
      c.throw(400, "bad input");
    });
    const res = await app.handle(req("/e"));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  });

  it("a thrown handler's error page still carries the nonce policy", async () => {
    const app = new Keala(quiet);
    app.use(
      secureHeaders({
        csp: "script-src {nonce}",
        nonce: () => "errbeef",
      }),
    );
    app.get("/e", (c) => {
      c.throw(500, "boom");
    });
    const res = await app.handle(req("/e"));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-security-policy")).toBe("script-src 'nonce-errbeef'");
  });
});

describe("requestId", () => {
  it("generates ids and echoes them", async () => {
    const app = new Keala(quiet);
    app.use(requestId());
    app.get("/x", (c) => {
      c.setHeader("X-State-Id", String(c.state.requestId ?? ""));
      return c.text("ok");
    });
    const res = await app.handle(req("/x"));
    const id = res.headers.get("x-request-id");
    expect(id).not.toBeNull();
    expect(res.headers.get("x-state-id")).toBe(id);
  });

  it("honors valid inbound ids and replaces garbage", async () => {
    const app = new Keala(quiet);
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
    const app = new Keala(quiet);
    app.use(timing());
    app.get("/x", async (c) => {
      (c.state as { timingMark?: (n: string) => void }).timingMark?.("db");
      return c.text("ok");
    });
    const res = await app.handle(req("/x"));
    const value = res.headers.get("server-timing") ?? "";
    expect(value).toContain("total;dur=");
    expect(value).toContain("db;dur=");
  });

  it("Server-Timing is still written when the handler throws", async () => {
    const app = new Keala(quiet);
    app.use(timing());
    app.get("/e", async (c) => {
      (c.state as { timingMark?: (n: string) => void }).timingMark?.("db");
      c.throw(500, "boom");
    });
    const res = await app.handle(req("/e"));
    expect(res.status).toBe(500);
    const value = res.headers.get("server-timing") ?? "";
    expect(value).toContain("total;dur=");
    expect(value).toContain("db;dur=");
  });

  it("logger writes one structured line per request", async () => {
    const lines: string[] = [];
    const app = new Keala(quiet);
    app.use(logger({ write: (line) => lines.push(line) }));
    app.get("/x", (c) => c.text("ok"));
    await app.handle(req("/x"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^GET \/x -> 200 \d+ms -$/);
  });
});
