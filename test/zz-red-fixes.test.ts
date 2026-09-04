/**
 * zz-red-fixes — regression locks for the 0.6.2 review fix round:
 * BUG-6 (committed bodied 204/304 must still merge staged headers before
 * sanitation) and SEC-2 (websocket upgrade origin enforcement, CSWSH).
 * The remaining fix behaviors (redirect code preservation, takeover
 * set-cookie joins, c.throw 3xx TypeError) are locked in zz-red-bugs-1..7
 * and zz-red-ux-2.
 */
import { describe, expect, it } from "vitest";
import { Keala } from "../src/index.ts";
import { finalize } from "../src/core/respond.ts";
import type { Context } from "../src/index.ts";

const hit = async (
  app: InstanceType<typeof Keala>,
  path: string,
  init?: RequestInit,
): Promise<Response> => app.handle(new Request(`http://localhost${path}`, init));

describe("BUG-6: staged headers merge before empty-status sanitation", () => {
  it("committed bodied 304 merges staged security headers, drops content ones", async () => {
    // Node/undici refuses bodied null-body-status construction, so the
    // committed Response is built bodied at 200 and its `status` accessor is
    // shadowed — finalize only reads .status/.body/.headers, exactly what a
    // Bun-constructed bodied 304 exposes.
    const bodied = new Response("payload", {
      status: 200,
      headers: { "content-type": "text/plain", "x-own": "committed" },
    });
    Object.defineProperty(bodied, "status", { value: 304 });
    const app = new Keala({ env: "test" });
    const c = {
      _res: bodied,
      headersRecord: { "x-sec": "staged", "content-type": "text/plain" },
      method: "GET",
    } as unknown as Context;
    const out = await finalize(app, c); // committed path is sync by construction
    expect(out.status).toBe(304);
    expect(await out.text()).toBe(""); // body sanitized away
    expect(out.headers.get("x-sec")).toBe("staged"); // the BUG-6 regression: merge happened
    expect(out.headers.get("x-own")).toBe("committed"); // committed headers survive
    expect(out.headers.get("content-type")).toBeNull(); // content headers sanitized
  });

  it("staged set-cookie joins a committed bodied 304 before sanitation", async () => {
    const bodied = new Response("x", { status: 200 });
    Object.defineProperty(bodied, "status", { value: 204 });
    const app = new Keala({ env: "test" });
    const c = {
      _res: bodied,
      headersRecord: { "set-cookie": ["late=1; Path=/"] },
      method: "GET",
    } as unknown as Context;
    const out = await finalize(app, c); // committed path is sync by construction
    expect(out.status).toBe(204);
    expect(await out.text()).toBe("");
    expect(out.headers.getSetCookie()).toEqual(["late=1; Path=/"]);
  });

  // Bun is the only runtime that can construct the bodied 204 for real —
  // the e2e shape (middleware staging + handler commit) is locked there.
  it.skipIf(typeof Bun === "undefined")(
    "e2e under Bun: bodied 204 keeps staged middleware headers",
    async () => {
      const app = new Keala({ env: "test" });
      app.use((c, next) => {
        c.setHeader("x-sec", "1");
        return next();
      });
      app.get("/", () => new Response("oops", { status: 204 }));
      const res = await hit(app, "/");
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers.get("x-sec")).toBe("1");
    },
  );
});

describe("SEC-2: websocket upgrade origin enforcement", () => {
  const upgradeServer = (seen: unknown[]): unknown => ({
    upgrade(_req: Request, opts: { data: unknown }): boolean {
      seen.push(opts.data);
      return true;
    },
  });
  const req = (path: string, origin?: string): Request =>
    new Request(`http://localhost:3000${path}`, {
      headers: origin === undefined ? {} : { origin },
    });

  it("array allowlist: same-origin upgrade proceeds (case-insensitive)", async () => {
    const seen: unknown[] = [];
    const app = new Keala({ env: "test" });
    app.ws("/chat", { origin: ["http://LOCALhost:3000"], open: () => undefined });
    const res = await app.handle(req("/chat", "http://localhost:3000"), {
      server: upgradeServer(seen),
    });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(1);
  });

  it("array allowlist: malicious origin is refused 403 before the upgrade", async () => {
    const seen: unknown[] = [];
    const app = new Keala({ env: "test" });
    app.ws("/chat", { origin: ["http://localhost:3000"], open: () => undefined });
    const res = await app.handle(req("/chat", "https://evil.example"), {
      server: upgradeServer(seen),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("origin");
    expect(seen.length).toBe(0); // the socket never opened
  });

  it("array allowlist: a missing Origin header is refused (fail closed)", async () => {
    const seen: unknown[] = [];
    const app = new Keala({ env: "test" });
    app.ws("/chat", { origin: ["http://localhost:3000"], open: () => undefined });
    const res = await app.handle(req("/chat"), { server: upgradeServer(seen) });
    expect(res.status).toBe(403);
    expect(seen.length).toBe(0);
  });

  it("predicate form owns the decision (false → 403, true → 101-path upgrade)", async () => {
    const seen: unknown[] = [];
    const app = new Keala({ env: "test" });
    app.ws("/chat", {
      origin: (c) => c.header("origin").endsWith(".trusted.example"),
      open: () => undefined,
    });
    const refused = await app.handle(req("/chat", "https://evil.example"), {
      server: upgradeServer(seen),
    });
    expect(refused.status).toBe(403);
    const allowed = await app.handle(req("/chat", "https://api.trusted.example"), {
      server: upgradeServer(seen),
    });
    expect(allowed.status).toBe(200);
    expect(seen.length).toBe(1);
  });

  it("no origin option keeps the previous upgrade-any behavior", async () => {
    const seen: unknown[] = [];
    const app = new Keala({ env: "test" });
    app.ws("/chat", { open: () => undefined });
    const res = await app.handle(req("/chat", "https://evil.example"), {
      server: upgradeServer(seen),
    });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(1);
  });

  it("mounted ws routes enforce the origin policy under the mount prefix", async () => {
    const seen: unknown[] = [];
    const app = new Keala({ env: "test" });
    const sub = new Keala({ env: "test" });
    sub.ws("/live", { origin: ["https://app.example"], open: () => undefined });
    app.mount("/api", sub);
    const refused = await app.handle(
      new Request("http://localhost/api/live", {
        headers: { origin: "https://evil.example" },
      }),
      { server: upgradeServer(seen) },
    );
    expect(refused.status).toBe(403);
    const allowed = await app.handle(
      new Request("http://localhost/api/live", {
        headers: { origin: "https://app.example" },
      }),
      { server: upgradeServer(seen) },
    );
    expect(allowed.status).toBe(200);
    expect(seen.length).toBe(1);
  });
});

describe("PERF-4: shared JSON init headers isolation", () => {
  it("consecutive JSON responses never share mutated header state", async () => {
    const app = new Keala({ env: "test" });
    app.get("/j", (c) => {
      c.body = { a: 1 }; // bare fast path (status 200)
      c.setHeader("x-tag", "one");
    });
    app.get("/js", (c) => {
      c.status = 201; // status-only fast path
      c.body = { b: 2 };
    });
    const a = await hit(app, "/j");
    const b = await hit(app, "/js");
    expect(a.headers.get("content-type")).toBe("application/json");
    expect(a.headers.get("x-tag")).toBe("one");
    expect(b.headers.get("content-type")).toBe("application/json");
    expect(b.headers.get("x-tag")).toBeNull(); // no leakage from request A
    expect(await a.text()).toBe('{"a":1}');
    expect(await b.text()).toBe('{"b":2}');
  });
});
