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
