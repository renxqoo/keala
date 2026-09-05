import { describe, expect, it } from "vitest";

import { Keala } from "../../src/index.ts";
import { Router } from "../../src/index.ts";
/**
 * zz-red-bugs-3 — corrected probes + pooling/deadline/signal/queue/mount round.
 */

const hit = async (
  app: InstanceType<typeof Keala>,
  path: string,
  init?: RequestInit,
): Promise<Response> => app.handle(new Request(`http://localhost${path}`, init));

describe("admission queue (latched)", () => {
  it("queue admits the waiter once capacity frees", async () => {
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, maxQueue: 2, queueTimeoutMs: 1000 },
    });
    let gateHits = 0;
    const gate = async (): Promise<void> => {
      gateHits++;
      await new Promise((r) => setTimeout(r, 30));
    };
    app.get("/hold", async () => {
      await gate();
      return new Response("done");
    });
    const first = app.handle(new Request("http://localhost/hold"));
    await new Promise((r) => setTimeout(r, 5));
    const second = app.handle(new Request("http://localhost/hold"));
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(gateHits).toBe(2); // the queued second request was admitted, not dropped
    expect(app.inFlight).toBe(0);
  });

  it("queued request evicted on client disconnect", async () => {
    const app = new Keala({
      env: "test",
      overload: { maxConcurrency: 1, maxQueue: 4, queueTimeoutMs: 5000 },
    });
    const ctl = new AbortController();
    let release: (() => void) | null = null;
    app.get("/hold", async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return new Response("done");
    });
    const first = app.handle(new Request("http://localhost/hold"));
    await new Promise((r) => setTimeout(r, 5));
    // NOTE: app.handle takes a Request; abort its own signal to simulate the
    // client walking away while queued.
    const queuedReq = new Request("http://localhost/hold", { signal: ctl.signal });
    const second = app.handle(queuedReq);
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    const settled = await second;
    expect(settled.status).toBe(503);
    // The cast resets TS's closure-blind narrowing to `null` (the assignment
    // happens inside the handler's promise executor).
    (release as (() => void) | null)?.();
    expect((await first).status).toBe(200);
  });
});

describe("deadline + signal", () => {
  it("zombie handler sees aborted c.signal (TimeoutError)", async () => {
    const app = new Keala({ env: "test", requestTimeout: 15 });
    let observed: unknown = "unset";
    app.get("/s", async (c) => {
      await new Promise((r) => setTimeout(r, 60));
      observed = c.signal.aborted ? (c.signal.reason as DOMException).name : "live";
      return new Response("late");
    });
    const res = await hit(app, "/s");
    expect(res.status).toBe(504);
    await new Promise((r) => setTimeout(r, 80));
    expect(observed).toBe("TimeoutError");
  });

  it("deadline + pooling: the zombie never corrupts the pool", async () => {
    const app = new Keala({ env: "test", pooling: true, requestTimeout: 10 });
    app.get("/slow", async (c) => {
      await new Promise((r) => setTimeout(r, 50));
      return c.text("late");
    });
    app.get("/ok", (c) => c.text("fine"));
    const timedOut = await hit(app, "/slow");
    expect(timedOut.status).toBe(504);
    const ok = await hit(app, "/ok");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("fine");
    await new Promise((r) => setTimeout(r, 80));
    const ok2 = await hit(app, "/ok");
    expect(await ok2.text()).toBe("fine");
  });

  it("a fast request under a deadline app settles normally", async () => {
    const app = new Keala({ env: "test", requestTimeout: 1000 });
    app.get("/f", (c) => c.text("fast"));
    const res = await hit(app, "/f");
    expect(await res.text()).toBe("fast");
    expect(app.inFlight).toBe(0);
  });
});

describe("scoped middleware semantics (documented)", () => {
  it('use("/api/*") is the subtree scope; use("/api") is exact', async () => {
    const app = new Keala({ env: "test" });
    const exact: string[] = [];
    const sub: string[] = [];
    app.use("/api", async (_c, next) => {
      exact.push("1");
      await next();
    });
    app.use("/api/*", async (_c, next) => {
      sub.push("1");
      await next();
    });
    app.get("/api", (c) => c.text("root"));
    app.get("/api/x", (c) => c.text("x"));
    app.get("/api/x/y", (c) => c.text("y"));
    await hit(app, "/api");
    await hit(app, "/api/x");
    await hit(app, "/api/x/y");
    expect(exact.length).toBe(1);
    expect(sub.length).toBe(3);
  });

  it("global + scoped interleave keeps registration order per route", async () => {
    const app = new Keala({ env: "test" });
    const order: string[] = [];
    app.use(async (_c, next) => {
      order.push("g1");
      await next();
    });
    app.use("/s/*", async (_c, next) => {
      order.push("s1");
      await next();
    });
    app.use(async (_c, next) => {
      order.push("g2");
      await next();
    });
    app.get("/s/a", (c) => c.text("ok"));
    await hit(app, "/s/a");
    expect(order).toEqual(["g1", "s1", "g2"]);
  });

  it("scoped middleware runs for 405 paths inside the scope", async () => {
    const app = new Keala({ env: "test" });
    let ran = false;
    app.use("/api/*", async (_c, next) => {
      ran = true;
      await next();
    });
    app.post("/api/thing", (c) => c.text("posted"));
    const res = await hit(app, "/api/thing", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(ran).toBe(true);
  });
});

describe("immutable committed Responses", () => {
  it("staged headers merge onto Response.redirect via rebuild", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.setHeader("x-a", "staged");
      return Response.redirect("https://example.com/x", 307);
    });
    const res = await hit(app, "/");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://example.com/x");
    expect(res.headers.get("x-a")).toBe("staged");
  });

  it("post-commit setHeader on an immutable response answers 500 loudly (undici)", async () => {
    const app = new Keala({ env: "test" });
    app.use(async (c, next) => {
      await next();
      c.setHeader("x-late", "1");
    });
    app.get("/", () => Response.redirect("http://localhost:3000/x", 302));
    const res = await hit(app, "/");
    if (typeof Bun === "undefined") {
      // undici: Response.redirect responses are immutable — the late write
      // throws and the funnel answers 500 loudly.
      expect(res.status).toBe(500);
    } else {
      // Bun ≥1.4.2: redirect responses are no longer immutable — the late
      // write lands directly on the committed Response per the 0.7
      // post-commit contract.
      expect(res.status).toBe(302);
      expect(res.headers.get("x-late")).toBe("1");
    }
  });
});

describe("0.7 commit contract guards", () => {
  it("c.body after commit throws (500)", async () => {
    const app = new Keala({ env: "test" });
    app.use(async (c, next) => {
      await next();
      c.body = "late";
    });
    app.get("/", (c) => c.text("hi"));
    const res = await hit(app, "/");
    expect(res.status).toBe(500);
  });

  it("c.status after commit throws (500)", async () => {
    const app = new Keala({ env: "test" });
    app.use(async (c, next) => {
      await next();
      c.status = 201;
    });
    app.get("/", (c) => c.text("hi"));
    const res = await hit(app, "/");
    expect(res.status).toBe(500);
  });
});

describe("error mapper + cookies", () => {
  it("mapper takeover keeps staged set-cookie and its own", async () => {
    const app = new Keala({ env: "test" });
    app.use((c, next) => {
      c.cookies.set("pre", "1");
      return next();
    });
    app.onError(
      () =>
        new Response("boom", {
          status: 500,
          headers: { "set-cookie": "post=2; Path=/" },
        }),
    );
    app.get("/", () => {
      throw new Error("x");
    });
    const res = await hit(app, "/");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((x) => x.startsWith("pre="))).toBe(true);
    expect(cookies.some((x) => x.startsWith("post="))).toBe(true);
  });

  it("error.headers ride the builtin response (WWW-Authenticate)", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) =>
      c.throw(401, "nope", { headers: { "www-authenticate": 'Basic realm="x"' } }),
    );
    const res = await hit(app, "/");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="x"');
  });
});

describe("query details", () => {
  it("value containing '=' is kept whole", async () => {
    const app = new Keala({ env: "test" });
    let v = "";
    app.get("/", (c) => {
      v = c.query("a") ?? "";
      return c.text("ok");
    });
    await hit(app, "/?a=b=c");
    expect(v).toBe("b=c");
  });

  it("encoded key form is found", async () => {
    const app = new Keala({ env: "test" });
    let v = "";
    app.get("/", (c) => {
      v = c.query("user name") ?? "";
      return c.text("ok");
    });
    await hit(app, "/?user+name=v1");
    expect(v).toBe("v1");
  });

  it("querystring stops at a fragment that precedes the query", async () => {
    const app = new Keala({ env: "test" });
    let qs = "";
    app.get("/", (c) => {
      qs = c.querystring;
      return c.text("ok");
    });
    await hit(app, "/x#frag?a=1");
    expect(qs).toBe("");
  });
});

describe("fastDynamic correctness (shared routes only)", () => {
  it("matches the trie reference on every shared shape", async () => {
    const single = new Keala({ env: "test" });
    single.get("/users/:id", (c) => c.text(`id:${c.params("id")}`));
    const ref = new Keala({ env: "test" });
    ref.get("/users/:id", (c) => c.text(`id:${c.params("id")}`));
    ref.get("/other/:x", (c) => c.text("other"));
    const paths = [
      "/users",
      "/users/",
      "/users/7",
      "/users/7/",
      "/users/a/b",
      "/users//x",
      "/",
      "/users/%C3%A6",
      "/users/a%20b",
      "/users/a%2Fb",
    ];
    for (const p of paths) {
      const a = await single.handle(new Request(`http://localhost${p}`));
      const b = await ref.handle(new Request(`http://localhost${p}`));
      expect([p, a.status, await a.text()]).toEqual([p, b.status, await b.text()]);
    }
  });
});

describe("pooling + stream bodies", () => {
  it("stream-bodied responses retire only after consumption", async () => {
    const app = new Keala({ env: "test", pooling: true });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });
    app.get("/s", () => new Response(body));
    app.get("/n", (c) => c.text("next"));
    const s = await hit(app, "/s");
    // Before consuming the stream, the context is NOT recycled
    await hit(app, "/n");
    expect(await s.text()).toBe("chunk");
  });

  it("late write on a retired context throws (guard)", async () => {
    const app = new Keala({ env: "test", pooling: true });
    let captured: unknown = null;
    app.get("/a", (c) => {
      captured = c;
      return c.text("A");
    });
    app.get("/b", (c) => c.text("B"));
    await hit(app, "/a");
    await hit(app, "/b");
    expect(captured).not.toBeNull();
    expect(() => {
      (captured as { status: number }).status = 500;
    }).toThrow(/retired/);
  });
});

describe("respond/serialize edges", () => {
  it("Uint8Array body: no runtime JSON; verbatim bytes", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.body = new Uint8Array([1, 2, 3]);
    });
    const res = await hit(app, "/");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("c.body = null on a JSON-typed 200 yields the literal null", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.type = "application/json";
      c.body = { a: 1 };
      c.body = null;
    });
    const res = await hit(app, "/");
    expect(await res.text()).toBe("null");
  });

  it("204 via c.status only: no content headers, empty body", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.status = 204;
    });
    const res = await hit(app, "/");
    expect(res.status).toBe(204);
    expect(res.headers.get("content-type")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
  });
});

/**
 * agent-r8 — full-project review round (four parallel reviewers, red-test
 * confirmation, fixes in the same commit). Each lock names the defect it
 * guards against; see the review report in the commit message.
 */

const quiet = { env: "test" } as const;

describe("r8 (0.7): a post-commit body rewrite throws — the committed body ships verbatim", () => {
  it("a string body write after a commit is a TypeError, wire stays in sync", async () => {
    const app = new Keala(quiet);
    const thrown: unknown[] = [];
    app.use(async (c, next) => {
      await next();
      try {
        c.body = "a much longer body";
      } catch (error) {
        thrown.push(error);
      }
    });
    // A committed Response carrying its own Content-Length (e.g. an upstream
    // fetch() response).
    app.get("/a", () => new Response("hi", { headers: { "content-length": "2" } }));
    const res = await app.handle(new Request("http://localhost:3000/a"));
    expect(thrown[0]).toBeInstanceOf(TypeError);
    // The invariant from the r8 review (never a stale length) now holds by
    // construction: the body is never replaced, so length and payload cannot
    // desync.
    expect(await res.text()).toBe("hi");
    expect(res.headers.get("content-length")).toBe("2");
  });

  it("a stream body write after a commit is a TypeError too", async () => {
    const app = new Keala(quiet);
    const thrown: unknown[] = [];
    app.use(async (c, next) => {
      await next();
      try {
        c.body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("a much longer streamed body"));
            controller.close();
          },
        });
      } catch (error) {
        thrown.push(error);
      }
    });
    app.get("/a", () => new Response("hi", { headers: { "content-length": "2" } }));
    const res = await app.handle(new Request("http://localhost:3000/a"));
    expect(thrown[0]).toBeInstanceOf(TypeError);
    expect(await res.text()).toBe("hi");
  });
});

describe("r8: failed ws registration leaves no stranded wsRoutes key", () => {
  it("a throwing app.ws() (sunk overlap) does not occupy the key", () => {
    const app = new Keala(quiet);
    app.sink("/static/*", { dir: "/tmp" });
    expect(() => app.ws("/static/x", { open() {} })).toThrow();
    expect(app.wsRoutes.has("/static/x")).toBe(false);
  });

  it("a throwing ws mount does not occupy the key either", () => {
    const app = new Keala(quiet);
    app.sink("/static/*", { dir: "/tmp" });
    const sub = new Keala(quiet);
    sub.ws("/", { open() {} });
    expect(() => app.mount("/static", sub)).toThrow();
    expect(app.wsRoutes.has("/static")).toBe(false);
  });
});

describe("r8: Router identity prefix", () => {
  it('prefix: "/" is the identity mount, not a broken "//path" factory', async () => {
    const app = new Keala(quiet);
    const r = new Router({ prefix: "/" });
    r.get("/x", (c) => {
      c.body = "ok";
    });
    app.mount("/", r);
    const res = await app.handle(new Request("http://localhost:3000/x"));
    expect([res.status, await res.text()]).toEqual([200, "ok"]);
  });
});
