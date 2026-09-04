/**
 * zz-red-bugs-4 — trustedHosts, close/shutdown, OPTIONS/OPTIONS+staged,
 * disposition, sugar arrays, mount-scope depth, misc edges.
 */
import { describe, expect, it } from "vitest";
import { Keala } from "../src/index.ts";
import { contentDisposition } from "../src/utils/text.ts";

const hit = async (
  app: InstanceType<typeof Keala>,
  path: string,
  init?: RequestInit,
): Promise<Response> => app.handle(new Request(`http://localhost${path}`, init));

describe("trustedHosts", () => {
  const app = new Keala({ env: "test", trustedHosts: ["*.example.com", "api.io"] });
  app.get("/", (c) => c.text("ok"));
  const probe = (host: string, extra?: Record<string, string>): Promise<Response> =>
    hit(app, "/", { headers: { host, ...extra } });

  it("admits exact and single-label wildcard hosts, port-insensitive", async () => {
    expect((await probe("api.io")).status).toBe(200);
    expect((await probe("API.IO:3000")).status).toBe(200);
    expect((await probe("a.example.com")).status).toBe(200);
    expect((await probe("a.example.com:443")).status).toBe(200);
  });
  it("refuses foreign and multi-label wildcard hosts", async () => {
    expect((await probe("evil.com")).status).toBe(403);
    expect((await probe("deep.a.example.com")).status).toBe(403);
    expect((await probe("example.com")).status).toBe(403);
  });
  it("refuses a poisoned forwarded chain", async () => {
    expect((await probe("api.io", { "x-forwarded-host": "evil.com" })).status).toBe(403);
    expect(
      (await probe("api.io", { "x-forwarded-host": "a.example.com, evil.com" })).status,
    ).toBe(200);
  });
});

describe("close/shutdown (embedded)", () => {
  it("close() settles, runs onShutdown once, isDraining flips", async () => {
    const app = new Keala({ env: "test" });
    const ran: number[] = [];
    app.onShutdown(() => {
      ran.push(1);
    });
    app.onShutdown(async () => {
      await new Promise((r) => setTimeout(r, 5));
      ran.push(2);
    });
    const first = app.close();
    expect(app.isDraining()).toBe(true);
    const status = await first;
    expect(status.timedOut).toBe(false);
    expect(ran).toEqual([1, 2]);
    const again = await app.close();
    expect(again.timedOut).toBe(false);
    expect(ran).toEqual([1, 2]);
  });

  it("draining refuses new requests with 503", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => c.text("ok"));
    void app.close();
    const res = await hit(app, "/");
    expect(res.status).toBe(503);
  });

  it("in-flight request settles across close()", async () => {
    const app = new Keala({ env: "test" });
    app.get("/slow", async () => {
      await new Promise((r) => setTimeout(r, 30));
      return new Response("done");
    });
    const req = app.handle(new Request("http://localhost/slow"));
    await new Promise((r) => setTimeout(r, 5));
    const closed = app.close({ drain: 500 });
    const settled = await req;
    expect(settled.status).toBe(200);
    expect(await settled.text()).toBe("done"); // drain-hold releases on consumption
    expect((await closed).timedOut).toBe(false);
    expect(app.inFlight).toBe(0);
  });
});

describe("OPTIONS / unknownMethodAs404", () => {
  it("OPTIONS carries staged middleware headers", async () => {
    const app = new Keala({ env: "test" });
    app.use((c, next) => {
      c.setHeader("x-g", "1");
      return next();
    });
    app.get("/x", (c) => c.text("g"));
    app.post("/x", (c) => c.text("p"));
    const res = await hit(app, "/x", { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("allow")).toBe("HEAD, GET, POST"); // ALLOW_ORDER (koa-router methods order)
    expect(res.headers.get("x-g")).toBe("1");
  });

  it("unknownMethodAs404 answers 404 instead of 501", async () => {
    const app = new Keala({ env: "test", unknownMethodAs404: true });
    app.get("/x", (c) => c.text("g"));
    const res = await hit(app, "/x", { method: "PROPFIND" });
    expect(res.status).toBe(404);
    expect(res.headers.get("allow")).toBeNull();
  });
});

describe("contentDisposition", () => {
  it("latin1 printable ships whole without filename*", () => {
    expect(contentDisposition("à.txt")).toBe('attachment; filename="à.txt"');
  });
  it("non-latin1 masks fallback and forces extended", () => {
    expect(contentDisposition("中.txt")).toBe(
      `attachment; filename="?.txt"; filename*=UTF-8''${encodeURIComponent("中.txt")}`,
    );
  });
  it("a %XX escape forces BOTH parameters", () => {
    expect(contentDisposition("a%20b")).toBe(
      `attachment; filename="a%20b"; filename*=UTF-8''${encodeURIComponent("a%20b")}`,
    );
  });
  it("quotes and backslashes are escaped", () => {
    expect(contentDisposition('a"b\\c')).toBe('attachment; filename="a\\"b\\\\c"');
  });
  it("explicit fallback wins the legacy slot", () => {
    expect(contentDisposition("中.txt", "zh")).toBe(
      `attachment; filename="zh"; filename*=UTF-8''${encodeURIComponent("中.txt")}`,
    );
  });
});

describe("sugar with per-call headers", () => {
  it("array header values preserve multi-value on the wire", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) =>
      c.json({ ok: true }, 200, { "set-cookie": ["a=1; Path=/", "b=2; Path=/"] }),
    );
    const res = await hit(app, "/");
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("per-call headers merge with staged (per-call wins per name)", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.setHeader("x-a", "staged");
      c.setHeader("x-keep", "staged");
      return c.text("ok", 200, { "X-A": "call" });
    });
    const res = await hit(app, "/");
    expect(res.headers.get("x-a")).toBe("call");
    expect(res.headers.get("x-keep")).toBe("staged");
  });

  it("staged set-cookie survives sugar consumption", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.cookies.set("k", "v");
      return c.text("ok");
    });
    const res = await hit(app, "/");
    expect(res.headers.getSetCookie()).toEqual(["k=v; Path=/"]);
  });

  it("cookie set AFTER sugar lands on the committed response", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      const r = c.text("ok");
      c.cookies.set("late", "1");
      return r;
    });
    const res = await hit(app, "/");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((x) => x.startsWith("late="))).toBe(true);
  });
});

describe("mount-scope depth", () => {
  it("nested mount of an app that itself mounted a router keeps inner use()", async () => {
    const inner = new Router0();
    inner.use(async (c, next) => {
      c.setHeader("x-inner", "1");
      await next();
    });
    inner.get("/leaf", (c) => c.text("leaf"));
    const mid = new Keala({ env: "test" });
    mid.mount("/m", inner);
    const outer = new Keala({ env: "test" });
    outer.mount("/o", mid);
    const res = await hit(outer, "/o/m/leaf");
    expect(res.headers.get("x-inner")).toBe("1");
    expect(await res.text()).toBe("leaf");
  });

  it("scoped middleware in a mounted app matches request paths through the offset", async () => {
    const sub = new Keala({ env: "test" });
    const seen: string[] = [];
    sub.use("/a/*", async (c, next) => {
      seen.push(c.path);
      await next();
    });
    sub.get("/a/:id", (c) => c.text(`id:${c.params.id}`));
    sub.get("/b/:id", (c) => c.text(`bid:${c.params.id}`));
    const app = new Keala({ env: "test" });
    app.mount("/pre", sub);
    await hit(app, "/pre/a/1");
    await hit(app, "/pre/b/1");
    expect(seen).toEqual(["/pre/a/1"]);
  });
});

// Minimal local router shim to avoid importing Router twice under different names.
import { Router } from "../src/router/group.ts";
class Router0 extends Router {}

describe("misc request edges", () => {
  it("empty query segments are tolerated", async () => {
    const app = new Keala({ env: "test" });
    let a: unknown;
    let b: unknown;
    app.get("/", (c) => {
      a = c.query("a");
      b = c.query("b");
      return c.text("ok");
    });
    await hit(app, "/?a=1&&b=2");
    expect([a, b]).toEqual(["1", "2"]);
  });

  it("referer/referrer lookups are interchangeable", async () => {
    const app = new Keala({ env: "test" });
    let r = "";
    app.get("/", (c) => {
      r = c.header("Referrer");
      return c.text("ok");
    });
    await hit(app, "/", { headers: { referer: "http://x/y" } });
    expect(r).toBe("http://x/y");
  });

  it("ip falls back to runtime requestIP", async () => {
    const app = new Keala({ env: "test" });
    let ip = "";
    app.get("/", (c) => {
      ip = c.ip;
      return c.text("ok");
    });
    await app.handle(
      new Request("http://localhost/"),
      ({
        server: { requestIP: () => ({ address: "10.0.0.7" }) },
      }) as never,
    );
    expect(ip).toBe("10.0.0.7");
  });

  it("proxy x-forwarded-for first entry with port stripped", async () => {
    const app = new Keala({ env: "test", proxy: true });
    let ip = "";
    app.get("/", (c) => {
      ip = c.ip;
      return c.text("ok");
    });
    await hit(app, "/", { headers: { "x-forwarded-for": "23.243.1.1:38242, 10.0.0.9" } });
    expect(ip).toBe("23.243.1.1");
  });
});

describe("etag middleware", () => {
  it("304 on If-None-Match; ETag on 200", async () => {
    const { etag } = await import("../src/middleware/etag.ts");
    const app = new Keala({ env: "test" });
    app.use(etag());
    app.get("/", (c) => {
      c.body = { hello: "world" };
    });
    const first = await hit(app, "/");
    const tag = first.headers.get("etag");
    expect(tag).toMatch(/^W\//);
    const second = await hit(app, "/", { headers: { "if-none-match": tag ?? "" } });
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(tag);
    expect(second.headers.get("content-type")).toBeNull();
  });
});
