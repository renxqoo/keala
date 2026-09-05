/**
 * ROUND 5 AUDIT — request lifecycle / compose / finalizer / pooling / streaming.
 *
 * CONFIRMED BUGS (each maps to a red `it` in the first describe):
 *
 *  [R5-1] HIGH  src/core/respond.ts:124 — `statusOverridden` conflates ANY
 *         flag-1 write with a POST-commit status override. A status staged
 *         BEFORE the commit (`c.status = 404`, `c.body = null` implicit-204
 *         [response.ts:142-144], `c.redirect()` [response.ts:307-311]) plus
 *         ANY post-commit flag-16 writer (`c.remove` / `c.message` /
 *         `c.status`) makes the rebuild take its status from the STALE
 *         pre-commit state instead of the committed Response: 200→404,
 *         200→204 (committed body dropped!), 200→302 resurrection.
 *         Fix: record the override intent at write time (a dedicated
 *         post-commit-status flag), or snapshot the committed status into
 *         statusValue at commit so stale state can never win.
 *  [R5-2] MED   src/core/context/pool.ts:116 + src/core/app.ts:443-445 —
 *         `retireWithBody()` calls `value.body.getReader()` unguarded. A
 *         handler returning a Response whose body stream is LOCKED (user
 *         called getReader() and never released) throws OUT of `app.handle()`:
 *         synchronously on sync chains, as a rejected promise on async chains
 *         — the only path that breaks the never-reject contract (everything
 *         else falls back to errorResponse/static 500). Fix: try/catch →
 *         release the context and answer 500.
 *  [R5-3] MED   src/core/context/response.ts:292-319 — `redirect()` writes
 *         `statusValue`/`flags |= 1` directly, bypassing the commit-aware
 *         status setter (no flag 16), and its body write is ignored by the
 *         rule-4 rebuild. A post-commit `c.redirect()` therefore ships
 *         status 200 + Location + content-type REPLACED with text/html + the
 *         ORIGINAL body — an incoherent non-redirect. Fix: flag 16 when
 *         `_res !== undefined` (like the status/message setters).
 *  [R5-4] MED   src/core/context/sugar.ts:89 + src/core/context/context.ts:59-83
 *         — the memoized `cookiesValue` facade is bound to the OLD
 *         `headersRecord` object; every sugar helper then swaps the slot to
 *         `null`, so any LATER `c.cookies.set()` writes into the detached
 *         record and silently disappears (both the same-request
 *         `const built = c.text(...); c.cookies.set(...)` form and the
 *         post-commit middleware form). Plain `c.setHeader()` keeps working and
 *         state-mode late cookies keep working — only the facade goes stale.
 *         Fix: give the facade a getter to the CURRENT record (or clear the
 *         consumed record's keys in place instead of swapping the slot).
 *  [R5-5] LOW   src/core/context/context.ts:157-162 — `sweepForeignKeys`
 *         iterates `Object.keys`, so symbol-keyed own properties are never
 *         swept and SURVIVE a pool recycle (request 2 reads request 1's
 *         object), contradicting the sweep's own contract. Fix: sweep
 *         `Reflect.ownKeys` symbols too.
 *  [R5-6] MED   src/core/respond.ts:279-291 — `observedStream.pull` wraps the
 *         DONE branch's `controller.close()` in the same try/catch that feeds
 *         `onError`. When a pull is in flight and the consumer cancels, the
 *         pending read resolves done and `close()` throws "Controller is
 *         already closed" on the ALREADY-CANCELLED controller; the catch then
 *         fires the app's `onStreamError` hook with that TypeError — a client
 *         abort is misreported as a producer error (and the context is already
 *         retired by then). Reproduces on the Bun runtime (this framework's
 *         primary target: `bun --bun x vitest run test/agent-r5-runtime.test.ts`);
 *         node/undici tolerates the late close() so the same test passes there.
 *         Fix: guard the done-branch close() separately so only reader.read()
 *         rejections reach onError.
 *
 * OBSERVATIONS (not encoded as red — judged design-adjacent, see report):
 *   - a sugar helper called but NOT returned consumes the staged headers into
 *     the discarded Response (documented "consume" semantics, surprising loss);
 *   - deep mutations bypass the retired-context write guard (`c.state.x = 1`,
 *     symbol props) — only accessor setters throw;
 *   - `decorate()` has no "requests already served" runtime guard (docs say
 *     setup-time only);
 *   - `app.onError` listener throw replaces the original error status with a
 *     plain static 500 (acceptable, never escapes handle).
 *
 * Everything in the second describe locks CORRECT behavior (green).
 */

import { describe, expect, it } from "vitest";

import { Keala, type Application } from "../../src/core/app.ts";

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

describe("agent r5 — confirmed bugs", () => {
  it("R5-1a: stale pre-commit status must not leak into a post-commit remove() rebuild", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      c.status = 404; // staged BEFORE the commit (koa 404-interceptor pattern)
      await next();
      c.remove("X-None"); // post-commit header removal triggers the rule-4 rebuild
    });
    app.get("/", () => new Response("hello"));
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(200); // actual: 404
    expect(await res.text()).toBe("hello");
  });

  // 0.7: R5-1b (post-commit message-only override) is gone with c.message
  // and the rule-4 rebuild — statusText customization no longer exists.

  it("R5-1c: pre-commit c.body=null must not turn a committed 200 into a bodyless 204", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      c.body = null; // reset idiom: flag 1 + implicit statusValue 204 (pre-commit)
      await next();
      c.remove("X-None"); // post-commit flag-16 writer
    });
    app.get("/", () => new Response("hello"));
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(res.status).toBe(200); // actual: 204
    expect(await res.text()).toBe("hello"); // actual: "" (body dropped)
  });

  it("R5-2a: pooling + handler-locked body must not throw out of handle() (sync chain)", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    app.get("/", () => {
      const res = new Response(streamOf(["hi"]));
      res.body?.getReader(); // user error: lock the body, never release
      return res;
    });
    let out: Response | undefined;
    let threw: unknown = null;
    try {
      out = await drive(app, new Request("http://localhost:3000/"));
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeNull(); // actual: TypeError "ReadableStream is locked"
    expect(out).toBeInstanceOf(Response);
    expect(out?.status).toBe(500);
  });

  it("R5-2b: pooling + handler-locked body must not reject handle() (async chain)", async () => {
    const app = new Keala({ ...quiet, pooling: true });
    app.get("/", async () => {
      const res = new Response(streamOf(["hi"]));
      res.body?.getReader();
      return res;
    });
    let out: Response | undefined;
    let rejected: unknown = null;
    try {
      out = await drive(app, new Request("http://localhost:3000/"));
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBeNull(); // actual: rejected promise
    expect(out).toBeInstanceOf(Response);
    expect(out?.status).toBe(500);
  });

  it("R5-3 (0.7): an auth middleware redirects by replacing the committed response", async () => {
    const app = new Keala(quiet);
    let caught: unknown;
    app.use(async (c, next) => {
      await next();
      try {
        c.redirect("/login"); // the old post-commit write — a loud TypeError now
      } catch (err) {
        caught = err;
      }
      // Supported pattern: return the replacement Response (last committer wins).
      return new Response(null, { status: 302, headers: { location: "/login" } });
    });
    app.get("/", () => new Response("secret data"));
    const res = await drive(app, new Request("http://localhost:3000/"));
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain("response already committed");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(await res.text()).toBe("");
  });

  it("R5-4a: late c.cookies.set() after a sugar return must not vanish (post-commit form)", async () => {
    const app = new Keala(quiet);
    app.use(async (c, next) => {
      void c.cookies.get("incoming"); // materialize the memoized facade early
      await next();
      c.cookies.set("b", "2"); // late cookie, staged after the sugar consumed the record
    });
    app.get("/c", (c) => {
      c.cookies.set("a", "1");
      return c.text("ok");
    });
    const res = await drive(app, new Request("http://localhost:3000/c"));
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]); // actual: ["a=1"]
  });

  it("R5-4b: late c.cookies.set() after a sugar return must not vanish (same-request form)", async () => {
    const app = new Keala(quiet);
    app.get("/c", (c) => {
      c.cookies.set("a", "1");
      const built = c.text("ok"); // consumes the staging record
      c.cookies.set("b", "2");
      return built;
    });
    const res = await drive(app, new Request("http://localhost:3000/c"));
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]); // actual: ["a=1"]
  });

  it("R5-5: symbol-keyed handler properties must be swept on pool recycle", async () => {
    const KEY = Symbol("r5");
    const app = new Keala({ ...quiet, pooling: true });
    app.get("/s", (c) => {
      const holder = c as unknown as Record<symbol, unknown>;
      const before = holder[KEY];
      holder[KEY] = { secret: "req1" };
      return c.text(String(before ?? "none"));
    });
    const r1 = await drive(app, new Request("http://localhost:3000/s"));
    expect(await r1.text()).toBe("none");
    const r2 = await drive(app, new Request("http://localhost:3000/s"));
    expect(await r2.text()).toBe("none"); // actual: "[object Object]" — request 1's data
  });

  it("R5-6: a client cancel mid-stream must not fire onStreamError (Bun runtime)", async () => {
    // RED under `bun --bun x vitest run test/agent-r5-runtime.test.ts`
    // (TypeError "Controller is already closed" reaches the app hook);
    // passes under node/undici — see the header note for R5-6.
    const errors: string[] = [];
    const app = new Keala({
      ...quiet,
      pooling: true,
      onStreamError: (err) => errors.push(String(err)),
    });
    app.get("/", (c) => {
      c.status = 200;
      c.body = streamOf(["a", "b", "c", "d", "e", "f"]);
    });
    const res = await drive(app, new Request("http://localhost:3000/"));
    const reader = res.body!.getReader();
    await reader.read(); // a pull is now in flight when the client aborts
    await reader.cancel("client went away");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errors).toEqual([]); // actual (Bun): ["...Controller is already closed"]
    const res2 = await drive(app, new Request("http://localhost:3000/"));
    expect(await res2.text()).toBe("abcdef");
  });
});
