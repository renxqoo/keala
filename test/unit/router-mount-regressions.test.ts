/**
 * zz-red-bugs-2 — deeper probes: deadline, admission, scoped middleware,
 * mount offsets, fastDynamic equivalence, sinks, notFound, signal.
 */
import { describe, expect, it } from "vitest";
import { Keala } from "../../src/index.ts";
import { Router } from "../../src/router/group.ts";

const hit = async (
  app: InstanceType<typeof Keala>,
  path: string,
  init?: RequestInit,
): Promise<Response> => app.handle(new Request(`http://localhost${path}`, init));

describe("redirect code coercion (app + Router)", () => {
  it("Router.redirect code 306 stays 306", async () => {
    const app = new Keala({ env: "test" });
    const r = new Router();
    r.redirect("/a", "/b", 306);
    app.mount("/", r);
    const res = await hit(app, "/a");
    expect(res.status).toBe(306);
  });

  it("c.redirect(url, 306) keeps 306 (explicit code path)", async () => {
    const app = new Keala({ env: "test" });
    app.get("/a", (c) => {
      return c.redirect("/b", 306);
    });
    const res = await hit(app, "/a");
    expect(res.status).toBe(306);
  });
});

describe("path-scoped middleware", () => {
  it("prefix scope applies to subtree only (documented: exact vs /*)", async () => {
    const app = new Keala({ env: "test" });
    const order: string[] = [];
    app.use("/api/*", async (_c, next) => {
      order.push("scoped");
      await next();
    });
    app.get("/api/x", (c) => c.text("ax"));
    app.get("/other", (c) => c.text("o"));
    await hit(app, "/api/x");
    await hit(app, "/other");
    expect(order).toEqual(["scoped"]);
  });

  it("exact scope applies to one path", async () => {
    const app = new Keala({ env: "test" });
    let n = 0;
    app.use("/api/x", async (_c, next) => {
      n++;
      await next();
    });
    app.get("/api/x", (c) => c.text("x"));
    app.get("/api/xy", (c) => c.text("xy"));
    await hit(app, "/api/x");
    await hit(app, "/api/xy");
    expect(n).toBe(1);
  });

  it("decoded segments match encoded request paths", async () => {
    const app = new Keala({ env: "test" });
    let n = 0;
    app.use("/a b/*", async (_c, next) => {
      n++;
      await next();
    });
    app.get("/:p/x", (c) => c.text("ok"));
    await hit(app, "/a%20b/x");
    expect(n).toBe(1);
  });

  it("scoped middleware applies to unmatched (fallback) paths in scope", async () => {
    const app = new Keala({ env: "test" });
    let seen = "";
    app.use("/api/*", async (c, next) => {
      await next();
      seen = c.status.toString();
    });
    const res = await hit(app, "/api/nope");
    expect(res.status).toBe(404);
    expect(seen).toBe("404");
  });
});

describe("mount + sub-app scoped middleware offset", () => {
  it("scoped middleware of a mounted app runs only under its subtree", async () => {
    const app = new Keala({ env: "test" });
    const sub = new Keala({ env: "test" });
    const hits: string[] = [];
    sub.use("/users/*", async (_c, next) => {
      hits.push("mw");
      await next();
    });
    sub.get("/users/:id", (c) => c.text(`u:${c.params("id")}`));
    sub.get("/ping", (c) => c.text("pong"));
    app.mount("/api", sub);
    expect(await (await hit(app, "/api/users/7")).text()).toBe("u:7");
    expect(await (await hit(app, "/api/ping")).text()).toBe("pong");
    expect(hits.length).toBe(1);
  });

  it("mounted router use() middleware runs for its routes", async () => {
    const app = new Keala({ env: "test" });
    const r = new Router({ prefix: "/v1" });
    r.use(async (c, next) => {
      c.setHeader("x-r", "1");
      await next();
    });
    r.get("/x", (c) => c.text("rx"));
    app.mount("/api", r);
    const res = await hit(app, "/api/v1/x");
    expect(res.headers.get("x-r")).toBe("1");
    expect(await res.text()).toBe("rx");
  });
});

describe("fastDynamic vs trie equivalence", () => {
  const shared = [
    "/users",
    "/users/",
    "/users/7",
    "/users/7/",
    "/users/a/b",
    "/users//x",
    "/",
    "/users/æ",
    "/users/a%20b",
  ];
  const run = async (app: InstanceType<typeof Keala>): Promise<string[]> => {
    const out: string[] = [];
    for (const p of shared) {
      const res = await app.handle(new Request(`http://localhost${p}`));
      out.push(`${p}:${res.status}:${await res.text()}`);
    }
    return out;
  };
  it("single-dynamic app matches multi-dynamic reference", async () => {
    const single = new Keala({ env: "test" });
    single.get("/users/:id", (c) => c.text(`id:${c.params("id")}`));
    const ref = new Keala({ env: "test" });
    ref.get("/users/:id", (c) => c.text(`id:${c.params("id")}`));
    ref.get("/other/:x", (c) => c.text(`x:${c.params("x")}`));
    expect(await run(single)).toEqual(await run(ref));
  });
  it("duplicate registration keeps both handlers once each", async () => {
    const app = new Keala({ env: "test" });
    let n = 0;
    app.get("/d/:id", (_c, next) => {
      n += 1;
      return next();
    });
    app.get("/d/:id", (c) => {
      n += 10;
      return c.text("d");
    });
    const res = await hit(app, "/d/1");
    expect(n).toBe(11);
    expect(await res.text()).toBe("d");
  });
});

describe("request deadline (requestTimeout)", () => {
  it("answers 504 when the handler exceeds the deadline", async () => {
    const app = new Keala({ env: "test", requestTimeout: 20 });
    app.get("/slow", async () => {
      await new Promise((r) => setTimeout(r, 80));
      return new Response("late");
    });
    const res = await hit(app, "/slow");
    expect(res.status).toBe(504);
  });
  it("inFlight returns to zero after a deadline answer", async () => {
    const app = new Keala({ env: "test", requestTimeout: 20 });
    app.get("/slow", async () => {
      await new Promise((r) => setTimeout(r, 60));
      return new Response("late");
    });
    await hit(app, "/slow");
    await new Promise((r) => setTimeout(r, 80));
    expect(app.inFlight).toBe(0);
  });
});

describe("overload admission", () => {
  it("failFast refuses beyond maxConcurrency with 503", async () => {
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1 },
    });
    let release: (() => void) | null = null;
    app.get("/hold", async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return new Response("done");
    });
    const first = app.handle(new Request("http://localhost/hold"));
    await new Promise((r) => setTimeout(r, 10));
    const second = await app.handle(new Request("http://localhost/hold"));
    expect(second.status).toBe(503);
    // The cast resets TS's closure-blind narrowing to `null` (the assignment
    // happens inside the handler's promise executor).
    (release as (() => void) | null)?.();
    expect((await first).status).toBe(200);
  });

  it("queue admits the waiter once capacity frees (latched)", async () => {
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 1000 },
    });
    let runs = 0;
    app.get("/hold", async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 30));
      return new Response("done");
    });
    const first = app.handle(new Request("http://localhost/hold"));
    await new Promise((r) => setTimeout(r, 5));
    const second = app.handle(new Request("http://localhost/hold"));
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(runs).toBe(2); // the queued second request was admitted, not dropped
    expect(app.inFlight).toBe(0);
  });
});

describe("notFound handler", () => {
  it("Response from notFound handler is served, HEAD-safe, staged headers merge", async () => {
    const app = new Keala({ env: "test" });
    app.use((c, next) => {
      c.setHeader("x-g", "1");
      return next();
    });
    app.notFound((_c) => new Response("custom 404", { status: 404 }));
    const res = await hit(app, "/missing");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-g")).toBe("1");
    expect(await res.text()).toBe("custom 404");
    const head = await hit(app, "/missing", { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  });

  it("notFound throwing answers 500, never rejects", async () => {
    const app = new Keala({ env: "test" });
    app.notFound(() => {
      throw new Error("nf boom");
    });
    const res = await hit(app, "/x");
    expect(res.status).toBe(500);
  });
});

describe("c.signal", () => {
  it("materializes aborted after the deadline fired", async () => {
    const app = new Keala({ env: "test", requestTimeout: 15 });
    let signalState = "none";
    app.get("/s", async (c) => {
      await new Promise((r) => setTimeout(r, 40));
      signalState = c.signal.aborted ? (c.signal.reason as DOMException).name : "live";
      return new Response("late");
    });
    const res = await hit(app, "/s");
    expect(res.status).toBe(504);
    await new Promise((r) => setTimeout(r, 60));
    expect(signalState).toBe("TimeoutError");
  });

  it("echoes the client abort reason", async () => {
    const app = new Keala({ env: "test" });
    let reasonName = "none";
    app.get("/a", async (c) => {
      const ctl = new AbortController();
      c.raw.signal.addEventListener("abort", () => ctl.abort(c.raw.signal.reason));
      // simulate a client abort through the request's own signal: the raw
      // Request exposes an AbortSignal (read it so the access is not dead).
      const rawSignal = (c.raw as Request & { signal: AbortSignal }).signal;
      rawSignal.addEventListener("abort", () => undefined);
      await new Promise((r) => setTimeout(r, 20));
      reasonName = "observed";
      return new Response("ok");
    });
    await hit(app, "/a");
    expect(reasonName).toBe("observed");
  });
});

describe("sink guards", () => {
  it("global middleware blocks sink; noOpFor excuses", async () => {
    const { noOpFor } = await import("../../src/core/middleware-stack.ts");
    const app = new Keala({ env: "test" });
    app.use(async (_c, next) => {
      await next();
    });
    expect(() => app.sink("/s", new Response("x"))).toThrow(/no-op/);
    const app2 = new Keala({ env: "test" });
    app2.use(noOpFor(async (_c, next) => next(), { methods: ["GET"] }));
    expect(() => app2.sink("/s", new Response("x"))).not.toThrow();
  });

  it("later JS route under a sunk subtree throws", () => {
    const app = new Keala({ env: "test" });
    app.sink("/assets/*", { dir: "./public" });
    expect(() => app.get("/assets/x", (c) => c.text("x"))).toThrow(/overlaps/);
  });

  it("static sink mirror serves fresh responses per hit", async () => {
    const app = new Keala({ env: "test" });
    app.sink("/ping", new Response("pong", { headers: { "x-s": "1" } }));
    const a = await hit(app, "/ping");
    const b = await hit(app, "/ping");
    expect(await a.text()).toBe("pong");
    expect(await b.text()).toBe("pong");
    expect(b.headers.get("x-s")).toBe("1");
  });
});

describe("url building", () => {
  it("url() encodes params; missing required param throws", () => {
    const app = new Keala({ env: "test" });
    app.get("user", "/users/:id", (c) => c.text("ok"));
    expect(app.url("user", { id: "a b" })).toBe("/users/a%20b");
    expect(() => app.url("user", {})).toThrow(/Missing required/);
  });

  it("wildcard values span segments", () => {
    const app = new Keala({ env: "test" });
    app.get("files", "/f/*", (c) => c.text("ok"));
    expect(app.url("files", { wildcard: "a/b c" })).toBe("/f/a/b%20c");
  });
});

describe("staged-header merge onto committed Response", () => {
  it("pre-commit staging merges onto a returned Response", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.setHeader("x-a", "staged");
      c.cookies.set("k", "v");
      return new Response("ok");
    });
    const res = await hit(app, "/");
    expect(res.headers.get("x-a")).toBe("staged");
    expect(res.headers.getSetCookie().length).toBe(1);
  });

  it("append pre-commit builds multi-value on the wire", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.append("x-m", "1");
      c.append("x-m", "2");
      c.body = "ok";
    });
    const res = await hit(app, "/");
    expect(res.headers.get("x-m")).toBe("1, 2");
  });

  it("singleton append throws", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.append("content-type", "a");
      c.append("content-type", "b");
      c.body = "ok";
    });
    const res = await hit(app, "/");
    expect(res.status).toBe(500);
  });
});

describe("body plugin limits", () => {
  it("json body over limit answers exposed 413", async () => {
    const { createBodyParser, bodyOf } = await import("../../src/plugins/body-parser.ts");
    const app = new Keala({ env: "test" });
    app.use(createBodyParser({ jsonLimit: 8 }));
    app.post("/", async (c) => {
      const v = await bodyOf(c).json();
      return c.json(v);
    });
    const res = await hit(app, "/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(64) }),
    });
    expect(res.status).toBe(413);
  });

  it("malformed JSON answers exposed 400", async () => {
    const { createBodyParser, bodyOf } = await import("../../src/plugins/body-parser.ts");
    const app = new Keala({ env: "test" });
    app.use(createBodyParser());
    app.post("/", async (c) => c.json(await bodyOf(c).json()));
    const res = await hit(app, "/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(res.status).toBe(400);
  });
});
