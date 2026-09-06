/**
 * ROUND 5 AUDIT — locks correct behavior (request lifecycle / compose /
 * finalizer / pooling / streaming). Split from agent-r5-runtime.test.ts for
 * the 500-line file budget; the CONFIRMED-BUG red tests live there.
 */

import { describe, expect, it } from "vitest";

import { Keala, type Application } from "../../src/core/app.ts";
import { createCookies } from "../../src/index.ts";

const quiet = { env: "test" } as const;
const drive = (app: Application, req: Request) => app.handle(req);

const streamOf = (chunks: string[], errorAt?: number): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (errorAt !== undefined && i === errorAt) {
        controller.error(new Error("producer boom"));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++] ?? ""));
    },
  });
};

describe("agent r5 — locks correct behavior", () => {
  it("compose: floating next() rejection stays observed — no unhandledRejection, early commit wins", async () => {
    const seen: unknown[] = [];
    const onUR = (reason: unknown) => seen.push(reason);
    (process.on as (event: string, fn: (reason: unknown) => void) => void)(
      "unhandledRejection",
      onUR,
    );
    try {
      const app = new Keala(quiet);
      app.use(() => new Response("early")); // returns without awaiting next()
      app.use(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("downstream boom");
      });
      const res = await drive(app, new Request("http://localhost:3000/"));
      expect(await res.text()).toBe("early");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(seen).toEqual([]);
    } finally {
      (process.off as (event: string, fn: (reason: unknown) => void) => void)(
        "unhandledRejection",
        onUR,
      );
    }
  });

  it("compose: double next() answers 500 and never escapes handle()", async () => {
    const app = new Keala(quiet);
    app.use((_c, next) => {
      next();
      next(); // guarded
      return new Response("x");
    });
    app.get("/d", () => new Response("route"));
    const res = await drive(app, new Request("http://localhost:3000/d"));
    expect(res.status).toBe(500);
  });

  it("compose: a custom thenable handler return answers 500 (loud, never hangs)", async () => {
    const app = new Keala(quiet);
    // eslint-disable-next-line unicorn/no-thenable
    app.get("/", () => ({ then() {} }) as unknown as Response);
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
  });

  it("dispatch: a throwing onError listener falls back to the static 500, handle resolves", async () => {
    const app = new Keala(quiet);
    app.onError(() => {
      throw new Error("listener boom");
    });
    app.get("/", () => {
      throw new Error("handler boom");
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it("dispatch: a __proto__ key in error.headers is dropped per-header, the rest survive", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => {
      const headers = JSON.parse('{"__proto__":"evil","x-reason":"ok"}') as Record<string, string>;
      c.throw(409, { headers });
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(409);
    expect(res.headers.get("x-reason")).toBe("ok");
  });

  it("dispatch: error.status = 1 (invalid) answers 500 — never reaches the status setter", async () => {
    const app = new Keala(quiet);
    app.get("/", () => {
      const err = new Error("weird status") as Error & { status: number };
      err.status = 1;
      throw err;
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
  });

  it("dispatch: a thrown string normalizes to 500", async () => {
    const app = new Keala(quiet);
    app.get("/", () => {
      throw "plain string";
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(500);
  });

  it("sink: concurrent first hits, replay, failing source retries, 204 sink", async () => {
    const app = new Keala(quiet);
    app.sink("/static", new Response("sunk-body", { headers: { "x-sunk": "1" } }));
    const [a, b] = await Promise.all([
      drive(app, new Request("http://localhost:3000/static")),
      drive(app, new Request("http://localhost:3000/static")),
    ]);
    expect(await a.text()).toBe("sunk-body");
    expect(await b.text()).toBe("sunk-body");
    const c = await drive(app, new Request("http://localhost:3000/static"));
    expect(await c.text()).toBe("sunk-body");
    expect(c.headers.get("x-sunk")).toBe("1");

    const app2 = new Keala(quiet);
    app2.sink("/bad", new Response(streamOf(["x"], 1)));
    const r1 = await drive(app2, new Request("http://localhost:3000/bad"));
    expect(r1.status).toBe(500);
    const r2 = await drive(app2, new Request("http://localhost:3000/bad"));
    expect(r2.status).toBe(500);

    const app3 = new Keala(quiet);
    app3.sink("/empty", new Response(null, { status: 204, headers: { "x-e": "1" } }));
    const r3 = await drive(app3, new Request("http://localhost:3000/empty"));
    expect(r3.status).toBe(204);
    expect(r3.body).toBeNull();
    expect(r3.headers.get("x-e")).toBe("1");
  });

  // SRC-REGRESSION (U3c): the state-mode finalizer's onStreamError wiring
  // (old respond.ts streamHook → repumpStream on the staged body) was
  // deleted with the setter family and NOT re-homed onto the committed
  // Response path — grep src/ for `onStreamError` consumers: only the
  // constructor assignment survives. The rewritten return-style tests below
  // are therefore expected to FAIL until the hook is re-wired (e.g. in
  // finishCommitted); flip `it.fails` back to `it` when it is.
  it("pooling: onStreamError fires on the LIVE context before retire, stream errors onward", async () => {
    let sawUrl = "";
    let sawStatus = 0;
    const app = new Keala({
      ...quiet,
      pooling: true,
      onStreamError: (err, c) => {
        sawUrl = c.url;
        sawStatus = c.status;
        void err;
      },
    });
    app.get("/s", () => new Response(streamOf(["ab", "cd"], 2)));
    app.get("/ok", (c) => c.text("ok"));
    const res = await drive(app, new Request("http://localhost:3000/s"));
    await expect(res.text()).rejects.toThrow(/producer boom/);
    expect(sawUrl).toBe("/s");
    expect(sawStatus).toBe(200);
    const res2 = await drive(app, new Request("http://localhost:3000/ok"));
    expect(await res2.text()).toBe("ok");
  });

  it("streaming: onStreamError without pooling observes the producer error with the live context", async () => {
    const order: string[] = [];
    const app = new Keala({
      ...quiet,
      onStreamError: (err, c) => order.push(`${(err as Error).message}:${c.url}`),
    });
    app.get("/e", () => new Response(streamOf(["x"], 1)));
    const res = await drive(app, new Request("http://localhost:3000/e"));
    await expect(res.text()).rejects.toThrow(/producer boom/);
    expect(order).toEqual(["producer boom:/e"]);
  });

  it("pooling: handler-assigned string keys over a decorate() value are swept on recycle", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    app.decorate("tenant", "base");
    app.get("/", (c) => {
      const ctx = c as unknown as { tenant: string };
      const before = ctx.tenant;
      ctx.tenant = "req1-mutation";
      return c.text(before);
    });
    const r1 = await drive(app, new Request("http://localhost:3000/"));
    expect(await r1.text()).toBe("base");
    const r2 = await drive(app, new Request("http://localhost:3000/"));
    expect(await r2.text()).toBe("base"); // proto value again, not req1-mutation
  });

  it("finalizer: HEAD + staged headers on a committed stream merge WITHOUT reading the body", async () => {
    // R7-CORE-4: the finalizer never reads a committed body — an open producer
    // must never block handle(). CL/CT stay what the Response itself exposes.
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.setHeader("X-Late", "1");
    });
    app.get("/", () => new Response(streamOf(["abc"])));
    const res = await drive(app, new Request("http://localhost:3000/", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-late")).toBe("1");
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-type")).toBeNull();
    expect(res.body).toBeNull();
  });

  it("finalizer: sugar 204 stays 204/empty (U3c rewrite of the status-then-body lock)", async () => {
    const app = new Keala(quiet);
    app.get("/", (c) => {
      return c.text("x", 204);
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("finalizer: HEAD + unmatched method answers 405 with Allow and staged global headers", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      c.setHeader("X-Global", "1");
      await next();
    });
    app.post("/x", (c) => c.text("posted"));
    const res = await drive(app, new Request("http://localhost:3000/x", { method: "HEAD" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("x-global")).toBe("1");
    expect(res.body).toBeNull();
  });

  it("finalizer: a late header write carries NO sniffed content-type (R7-CORE-3 parity)", async () => {
    // Sniffing would require reading the body; the finalizer never does. A
    // bare bytes Response carries no CT on the decorated path either.
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.setHeader("X-Late", "1");
    });
    app.get("/", () => new Response(new Uint8Array([0x00, 0x01, 0xff, 0xfe])));
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.headers.get("x-late")).toBe("1");
    expect(res.headers.get("content-type")).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(4);
  });

  // U3c deletion: "finalizer: state-mode LOCKED stream body answers 500"
  // locked the staged-body finalizer's locked-stream detection. The
  // return-style equivalent (a handler returning a locked-body Response
  // answers 500 through retireWithBody's guard) is locked by R5-2a/R5-2b in
  // app-regressions.test.ts.

  it("finalizer (0.7): a DISTURBED committed body never crashes the finalizer — the failure belongs to the consumer", async () => {
    const app = new Keala(quiet);
    app.use(createCookies());
    app.use(async (c, next) => {
      await next();
      c.setHeader("X-Late", "1");
    });
    app.get("/", async () => {
      const res = new Response(new Uint8Array([1, 2, 3]));
      await res.arrayBuffer(); // disturbs the body
      return res;
    });
    // No rebuild means no finalizer read of committed bodies; the adapters'
    // onServeError owns the wire-level 500 (test/adapters-node-sink.test.ts).
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.headers.get("x-late")).toBe("1");
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("sugar: plain c.setHeader after a sugar return still merges (control for R5-4)", async () => {
    const app = new Keala(quiet);
    app.use(createCookies());
    app.use(async (c, next) => {
      await next();
      c.setHeader("X-Late", "1");
    });
    app.get("/k", (c) => (c.setHeader("X-Early", "1"), c.text("ok")));
    const res = await drive(app, new Request("http://localhost:3000/k"));
    expect(res.headers.get("x-early")).toBe("1");
    expect(res.headers.get("x-late")).toBe("1");
  });

  it("sugar: HEAD on a sugar response backfills Content-Length and drops the body", async () => {
    const app = new Keala(quiet);
    app.use(createCookies());
    app.get("/h", (c) => c.text("hello"));
    const res = await drive(app, new Request("http://localhost:3000/h", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.body).toBeNull();
  });

  it("sugar: 304 keeps validators/cookies and drops content headers", async () => {
    const app = new Keala(quiet);
    app.use(createCookies());
    app.get("/e", (c) => {
      c.cookies.set("sess", "1");
      return c.text("nvm", 304);
    });
    const res = await drive(app, new Request("http://localhost:3000/e"));
    expect(res.status).toBe(304);
    expect(res.headers.getSetCookie()).toEqual(["sess=1; Path=/"]);
    expect(res.headers.get("content-type")).toBeNull();
  });

  it("pooling: a 500 followed by a healthy request recycles cleanly", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    app.get("/a", () => {
      throw new Error("boom");
    });
    app.get("/b", (c) => c.text(`ok:${c.url}`));
    const r1 = await drive(app, new Request("http://localhost:3000/a"));
    expect(r1.status).toBe(500);
    await r1.text();
    const r2 = await drive(app, new Request("http://localhost:3000/b"));
    expect(await r2.text()).toBe("ok:/b");
  });

  // U3c deletion: "0.7: a post-commit status override is a TypeError; the
  // override pattern returns a new Response" — both halves locked deleted
  // APIs (the post-commit `c.status =` freeze TypeError, and the `c.res`
  // getter feeding the rebuild). Last-committer-wins replacement stays
  // locked by R5-3 (U3a) in app-regressions.test.ts and "last committer
  // wins" in response-regressions.test.ts.

  it("0.7: a not-modified takeover keeps validators, drops content headers (override pattern)", async () => {
    const app = new Keala(quiet);
    // U3c: `c.res` is gone — the route handler's Response is captured in a
    // variable (the sanctioned post-next observation pattern).
    let committed: Response | undefined;
    app.use(async (_c, next) => {
      await next();
      const inner = committed;
      if (inner === undefined || inner.status !== 200) return;
      const headers = new Headers(inner.headers);
      headers.delete("content-type");
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      return new Response(null, { status: 304, headers });
    });
    app.get(
      "/f",
      () =>
        (committed = new Response("body", {
          headers: { etag: '"v1"', "content-type": "text/plain" },
        })),
    );
    const res = await drive(app, new Request("http://localhost:3000/f"));
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"v1"');
    expect(res.headers.get("content-type")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("rule 4: staged writes replace, removals drop, untouched committed headers survive", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      await next();
      c.setHeader("X-Replace", "second");
      c.remove("X-Drop");
    });
    app.get(
      "/m",
      () =>
        new Response("b", {
          headers: { "X-Replace": "first", "X-Drop": "1", "X-Keep": "k" },
        }),
    );
    const res = await drive(app, new Request("http://localhost:3000/m"));
    expect(res.headers.get("x-replace")).toBe("second");
    expect(res.headers.get("x-drop")).toBeNull();
    expect(res.headers.get("x-keep")).toBe("k");
  });

  it("pooling: concurrent recycled contexts keep their stream bodies separate", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    const enc = new TextEncoder();
    app.get("/s/:id", (c) => {
      const id = c.params("id") ?? "?";
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(enc.encode(`${id}-`));
            controller.close();
          },
        }),
      );
    });
    await (await drive(app, new Request("http://localhost:3000/s/0"))).text(); // warm the pool
    const [a, b, c] = await Promise.all([
      drive(app, new Request("http://localhost:3000/s/1")),
      drive(app, new Request("http://localhost:3000/s/2")),
      drive(app, new Request("http://localhost:3000/s/3")),
    ]);
    expect(await a.text()).toBe("1-");
    expect(await b.text()).toBe("2-");
    expect(await c.text()).toBe("3-");
  });

  it("pooling: retireWithBody wrapper preserves status, statusText, headers and body", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    app.get(
      "/w",
      () => new Response("body", { status: 201, statusText: "Made", headers: { "x-w": "1" } }),
    );
    const res = await drive(app, new Request("http://localhost:3000/w"));
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Made");
    expect(res.headers.get("x-w")).toBe("1");
    expect(await res.text()).toBe("body");
  });

  it("finalizer: staged-only headers ride on the 404 and on a notFound handler Response", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      c.setHeader("X-Global", "1");
      await next();
    });
    const res = await drive(app, new Request("http://localhost:3000/nope"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-global")).toBe("1");
    expect(await res.text()).toBe("Not Found");

    const app2 = new Keala(quiet);
    app2.use(async (c, next) => {
      c.setHeader("X-Global", "1");
      await next();
    });
    app2.notFound(() => new Response("custom nf", { status: 404, headers: { "x-nf": "1" } }));
    const res2 = await drive(app2, new Request("http://localhost:3000/nope"));
    expect(res2.status).toBe(404);
    expect(res2.headers.get("x-global")).toBe("1");
    expect(res2.headers.get("x-nf")).toBe("1");
    expect(await res2.text()).toBe("custom nf");
  });

  it("finalizer: HEAD + notFound handler Response + staged headers merges and strips", async () => {
    // R7: the finalizer never reads a committed body — no CL backfill.
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      c.setHeader("X-Global", "1");
      await next();
    });
    app.notFound(() => new Response("custom-nf-body", { status: 404 }));
    const res = await drive(app, new Request("http://localhost:3000/nope", { method: "HEAD" }));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("x-global")).toBe("1");
    expect(res.body).toBeNull();
  });
});
