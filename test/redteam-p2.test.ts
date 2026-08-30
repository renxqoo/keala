/**
 * Red-team audit — P2 component layer (see docs/v2-PARITY / commit 64d2647).
 *
 * Confirmed defects are locked as `it.skip` with a "CONFIRMED-BUG (P2-n)"
 * prefix: each assertion encodes the EXPECTED (fixed) behavior and fails
 * against the current implementation. Everything else is a green
 * equivalence/correctness asset for the attack surfaces probed:
 *   bodyParser boundaries, validator interplay, csrf/cors matrix, SSE/abort
 *   semantics, serveStatic traversal, websocket dispatch, component protocol,
 *   plus a 10-case core regression quick-scan under the new ctx fields.
 *
 * Findings ledger (severity, repro, root cause) lives in the audit report;
 * file:line references point at src/middleware/* and src/core/app.ts.
 *
 * Green assets split across two files (oxlint max-lines 500): this file
 * carries the locked bugs, serveStatic/websocket greens and the core
 * regression quick-scan; test/redteam-p2-2.test.ts carries the green
 * equivalence matrices for bodyParser, validator, csrf/cors, streams and
 * the component protocol.
 */

import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import { startBunServer } from "../src/adapters/bun.ts";
import { createBodyParser, type ContextWithBody } from "../src/plugins/body-parser.ts";
import { validator, type StandardSchema } from "../src/middleware/validator.ts";
import { cors, csrf } from "../src/middleware/cors.ts";
import { serveStatic } from "../src/middleware/serve-static.ts";
import { streamSSE } from "../src/helpers/streams.ts";
import { html, raw } from "../src/helpers/html.ts";
import { createRouter } from "../src/router/group.ts";

const quiet = { env: "test", silent: true } as const;
const req = (path: string, init: RequestInit = {}): Request =>
  new Request(`http://localhost:3000${path}`, init);
const passthrough = (): StandardSchema => ({
  "~standard": { version: 1, validate: (value: unknown) => ({ value }) },
});

// ---------------------------------------------------------------------------
// Filesystem fixtures (serveStatic attack lab)
// ---------------------------------------------------------------------------

let root = "";
let outside = "";
let stampPath = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bk-rt-p2-"));
  outside = join(dirname(root), "bk-rt-p2-outside");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "index.html"), "<h1>root index</h1>");
  await writeFile(join(root, "sub", "note.txt"), "sub note");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "TOP SECRET");
  // A symlinked DIRECTORY inside root (final components are regular files).
  await symlink(outside, join(root, "linkdir"));
  // A direct symlink file (control — denied by the lstat guard).
  await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
  // Pinned-mtime file for If-None-Match / If-Modified-Since precedence.
  stampPath = join(root, "stamp.txt");
  await writeFile(stampPath, "v2-content-longer");
  const pinned = new Date();
  await utimes(stampPath, pinned, pinned);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CONFIRMED BUGS — locked as skip; assertions state the expected behavior
// ---------------------------------------------------------------------------

describe("redteam P2: confirmed bugs (locked)", () => {
  it("CONFIRMED-BUG(now fixed) (P2-1): a smaller reader limit must still hold after an earlier larger read", async () => {
    const app = createApp(quiet);
    app.use(createBodyParser({ jsonLimit: 100, textLimit: 10 * 1024 * 1024 }));
    app.post("/x", async (c0) => {
      const c = c0 as ContextWithBody;
      await c.req.text(); // reads under the 10MB text limit first
      // jsonLimit=100 must still reject the 5KB memoized body — the throw
      // propagates straight into the error path (413, exposed).
      await c.req.json();
    });
    const res = await app.handle(
      req("/x", {
        method: "POST",
        body: JSON.stringify({ pad: "x".repeat(5000) }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("exceeds the 100 byte limit");
  });

  it("CONFIRMED-BUG(now fixed) (P2-2): validator must not override the app's configured body limits", async () => {
    // facet A: validator's hardcoded 1MB read 413s a body the app allows (5MB)
    const big = createApp(quiet);
    big.use(createBodyParser({ jsonLimit: 5 * 1024 * 1024 }));
    big.post("/v", validator(passthrough()), (c) => c.json({ ok: true }));
    const resA = await big.handle(
      req("/v", {
        method: "POST",
        body: JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(resA.status).toBe(200);

    // facet B: validator's 1MB read memoizes first, so a configured
    // jsonLimit=100 is silently bypassed by the handler's json() call
    const small = createApp(quiet);
    small.use(createBodyParser({ jsonLimit: 100 }));
    small.post("/v", validator(passthrough()), (c) => c.json({ ok: true }));
    const resB = await small.handle(
      req("/v", {
        method: "POST",
        body: JSON.stringify({ pad: "x".repeat(500) }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(resB.status).toBe(413);
  });

  it("CONFIRMED-BUG(now fixed) (P2-3): csrf must reject Origin: null (sandboxed-iframe forgery)", async () => {
    const app = createApp(quiet);
    app.use(csrf());
    app.post("/x", (c) => c.text("done"));
    const host = "localhost:3000";
    const byOrigin = await app.handle(
      req("/x", { method: "POST", headers: { origin: "null", host } }),
    );
    const byReferer = await app.handle(
      req("/x", { method: "POST", headers: { referer: "null", host } }),
    );
    expect(byOrigin.status).toBe(403);
    expect(byReferer.status).toBe(403);
  });

  it("CONFIRMED-BUG(now fixed) (P2-4): cors must not let a handler's Vary erase Vary: Origin", async () => {
    const app = createApp(quiet);
    app.use(cors({ origin: ["https://a.example"] }));
    app.get("/x", (c) => {
      c.set("Vary", "Accept-Language"); // its own variance axis
      return c.text("ok");
    });
    const res = await app.handle(req("/x", { headers: { origin: "https://a.example" } }));
    // A reflected ACAO without Vary: Origin lets a shared cache serve the
    // a.example variant to any other origin — cache poisoning surface.
    expect(res.headers.get("vary")?.toLowerCase()).toContain("origin");
    expect(res.headers.get("vary")?.toLowerCase()).toContain("accept-language");
  });

  it("CONFIRMED-BUG(now fixed) (P2-5): SSE data lines must sanitize lone CR (spec line terminator)", async () => {
    const app = createApp(quiet);
    app.get("/sse", (c) =>
      streamSSE(c, (sse) => {
        // The WHATWG SSE tokenizer terminates lines on CR, LF and CRLF, so a
        // lone CR in a data payload can split the event and inject fields
        // (event:/id:/retry:) or force an early dispatch with \r\r.
        sse.send({ data: "line1\r\revent: pwned\r\rid: 999" });
      }),
    );
    const res = await app.handle(req("/sse"));
    const text = await res.text();
    expect(text.includes("\r")).toBe(false); // every CR neutralized
    expect(text).toBe("data: line1  event: pwned  id: 999\n\n");
  });

  it("CONFIRMED-BUG(now fixed) (P2-6): serveStatic symlink guard must cover intermediate components", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root }));
    // linkdir is a symlink INSIDE root pointing outside; the requested final
    // component (secret.txt) is a regular file, so lstat(absolute) passes.
    const res = await app.handle(req("/linkdir/secret.txt"));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("TOP SECRET");
  });

  it("CONFIRMED-BUG(now fixed) (P2-7): directory-index resolution must re-check root containment", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root, index: "../../bk-rt-p2-outside/secret.txt" }));
    // A directory request resolves index relative to the DIRECTORY — escaping
    // and absolute index values walk straight out of root unchecked.
    const res = await app.handle(req("/sub"));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("TOP SECRET");
  });

  it("CONFIRMED-BUG(now fixed) (P2-8): a non-matching If-None-Match must disable If-Modified-Since", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root }));
    const base = await app.handle(req("/stamp.txt"));
    const lastModified = base.headers.get("last-modified") ?? "";
    // Stale entity tag + fresh modification date: RFC 9110 gives
    // If-None-Match precedence, so the (changed) representation must ship.
    const res = await app.handle(
      req("/stamp.txt", {
        headers: { "if-none-match": 'W/"deadbeef-deadbeef"', "if-modified-since": lastModified },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("CONFIRMED-BUG(now fixed) (P2-9): html`` must not honor a forgeable {__raw} marker from untrusted objects", async () => {
    // An attacker-controlled JSON body parsed into an object carries the raw()
    // protocol marker verbatim — interpolating it bypasses escaping (XSS).
    const untrusted = JSON.parse('{"__raw":"<img src=x onerror=alert(1)>"}') as unknown;
    const out = html`<div>${untrusted}</div>`;
    // The forged marker is inert data: rendered as escaped JSON, never
    // verbatim HTML and never "[object Object]".
    expect(out).toBe(
      "<div>{&quot;__raw&quot;:&quot;&lt;img src=x onerror=alert(1)&gt;&quot;}</div>",
    );
    expect(out).not.toContain("<img");
  });

  it("CONFIRMED-BUG(now fixed) (P2-10): an undecodable formData body must answer 4xx, not 500", async () => {
    const app = createApp(quiet);
    app.use(createBodyParser());
    app.post("/x", async (c0) => {
      const c = c0 as ContextWithBody;
      await c.req.formData(); // throws the exposed 400
    });
    const res = await app.handle(
      req("/x", {
        method: "POST",
        body: "123",
        headers: { "content-type": "application/json" }, // formData() cannot decode
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// serveStatic — containment that holds (green)
// ---------------------------------------------------------------------------

describe("redteam P2: serveStatic containment (green)", () => {
  it("double-encoded traversal (%252e%252e) never decodes into ..", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root }));
    const res = await app.handle(req("/%252e%252e/bk-rt-p2-outside/secret.txt"));
    const res2 = await app.handle(req("/..%2f..%2fbk-rt-p2-outside/secret.txt"));
    expect(res.status).toBe(404);
    expect(res2.status).toBe(404);
  });

  it("direct symlink files stay denied; a matching If-None-Match still 304s", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root }));
    const denied = await app.handle(req("/link.txt"));
    expect(denied.status).toBe(403);
    const base = await app.handle(req("/stamp.txt"));
    const etag = base.headers.get("etag") ?? "";
    const fresh = await app.handle(req("/stamp.txt", { headers: { "if-none-match": etag } }));
    expect(fresh.status).toBe(304);
    expect(fresh.body).toBeNull();
  });

  it("absolute-path-shaped requests stay inside root", async () => {
    const app = createApp(quiet);
    app.use(serveStatic({ root }));
    const doubled = await app.handle(req("//etc/passwd"));
    expect(doubled.status).toBe(404);
    const dotted = await app.handle(req("/../../etc/passwd"));
    expect(dotted.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// websocket — pattern paths, duplicates, dispatch (green)
// ---------------------------------------------------------------------------

describe("redteam P2: websocket (green)", () => {
  it("ws routes with params upgrade, thread params through socket data and the adapter", async () => {
    const upgradeCalls: { wsKey: string; ctx: unknown }[] = [];
    const server = {
      upgrade: (_r: Request, opts: { data: { wsKey: string; ctx: unknown } }) => {
        upgradeCalls.push(opts.data);
        return true;
      },
    };
    const app = createApp(quiet);
    const opened: string[] = [];
    app.ws("/ws/:id", {
      open: (_ws, c) => {
        opened.push(`${c.path}:${(c.params as Record<string, string | undefined>)["id"]}`);
      },
    });
    const res = await app.handle(req("/ws/42"), { server });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(upgradeCalls.map((u) => u.wsKey)).toEqual(["/ws/:id"]);
    const ctx = upgradeCalls[0]?.ctx as { params: Record<string, string> | null };
    expect(ctx.params?.["id"]).toBe("42");

    // adapter dispatch resolves handlers by the PATTERN key, not the concrete path
    let serveOptions: Record<string, unknown> | null = null;
    const fakeServe = (options: Record<string, unknown>) => {
      serveOptions = options;
      return {
        port: 0,
        hostname: "x",
        stop() {},
        fetch: () => new Response("1"),
        reload() {},
      };
    };
    const app2 = createApp(quiet);
    const seen2: string[] = [];
    app2.ws("/ws/:id", {
      open: (_ws, c) => {
        seen2.push(String((c.params as Record<string, string | undefined>)["id"]));
      },
    });
    startBunServer(app2, { port: 0 }, undefined, fakeServe as never);
    const dispatch = (
      serveOptions as unknown as {
        websocket?: { open?: (ws: unknown) => void };
      }
    ).websocket?.open;
    dispatch?.({ data: { wsKey: "/ws/:id", ctx } });
    await new Promise((r) => setTimeout(r, 0)); // handlers dispatch on a microtask
    expect(seen2).toEqual(["42"]);
    // unknown keys are silent no-ops
    expect(() => dispatch?.({ data: { wsKey: "/missing", ctx: undefined } })).not.toThrow();
  });

  it("duplicate app.ws on one path upgrades once and the last handlers serve events", async () => {
    const events: string[] = [];
    const upgradeCalls: { wsKey: string; ctx: unknown }[] = [];
    const server = {
      upgrade: (_r: Request, opts: { data: { wsKey: string; ctx: unknown } }) => {
        upgradeCalls.push(opts.data);
        return true;
      },
    };
    const app = createApp(quiet);
    app.ws("/dup", {
      open: () => {
        events.push("A-open");
      },
    });
    app.ws("/dup", {
      open: () => {
        events.push("B-open");
      },
    });
    const res = await app.handle(req("/dup"), { server });
    expect(res.status).toBe(200);
    expect(upgradeCalls.length).toBe(1); // no double-upgrade / no spurious 400
    const handlers = app.wsRoutes.get("/dup");
    handlers?.open?.({}, upgradeCalls[0]?.ctx as never);
    expect(events).toEqual(["B-open"]);
  });
});

// ---------------------------------------------------------------------------
// core regression quick-scan under the new ctx fields (green)
// ---------------------------------------------------------------------------

describe("redteam P2: core regression quick-scan (green)", () => {
  it("routing: static wins over params; encoded statics match; 405 carries Allow", async () => {
    const app = createApp(quiet);
    app.get("/users/admin", (c) => c.text("admin"));
    app.get("/users/:id", (c) => c.text(`id:${(c.params as Record<string, string>)["id"]}`));
    app.get("/a%20b", (c) => c.text("encoded"));
    app.post("/only-post", (c) => c.text("posted"));
    expect(await (await app.handle(req("/users/admin"))).text()).toBe("admin");
    expect(await (await app.handle(req("/users/42"))).text()).toBe("id:42");
    expect(await (await app.handle(req("/a%20b"))).text()).toBe("encoded");
    expect(await (await app.handle(req("/a b"))).text()).toBe("encoded");
    const rejected = await app.handle(req("/only-post", { method: "PUT" }));
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("allow")).toBe("POST");
  });

  it("HEAD backfills Content-Length from the would-be body", async () => {
    const app = createApp(quiet);
    app.get("/x", (c) => c.text("hello world"));
    const res = await app.handle(req("/x", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("content-length")).toBe("11");
  });

  it("set-cookie survives the error path; error responses reset state cleanly", async () => {
    const app = createApp(quiet);
    app.use((c, next) => {
      c.append("Set-Cookie", "a=1"); // staged before the downstream failure
      return next();
    });
    app.get("/x", () => {
      throw new Error("boom");
    });
    const res = await app.handle(req("/x"));
    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie()).toContain("a=1");
    expect(await res.text()).not.toContain("boom");
  });

  it("decorate stays isolated across apps; self-mount is rejected", async () => {
    const a = createApp(quiet);
    const b = createApp(quiet);
    a.decorate("onlyA", 1);
    expect(() => a.mount("/self", a)).toThrow(TypeError);
    a.get("/x", (c) => c.text(`a:${(c as unknown as { onlyA: number }).onlyA}`));
    b.get("/x", (c) => c.text(`b:${String((c as unknown as { onlyA?: number }).onlyA)}`));
    expect(await (await a.handle(req("/x"))).text()).toBe("a:1");
    expect(await (await b.handle(req("/x"))).text()).toBe("b:undefined");
  });

  it("floating next() containment: a handler that skips awaiting never crashes", async () => {
    const app = createApp(quiet);
    app.use((c, next) => {
      void next(); // deliberately not awaited; late rejection must be contained
      c.body = "early";
    });
    app.get("/x", () => Promise.reject(new Error("late")));
    const res = await app.handle(req("/x"));
    expect(await res.text()).toBe("early");
  });

  it("signed cookies round-trip; tampering is rejected", async () => {
    const app = createApp({ ...quiet, keys: ["secret"] });
    app.get("/read", (c) => c.text(`v=${c.cookies.get("v", { signed: true }) ?? "BAD"}`));
    app.get("/set", (c) => {
      c.cookies.set("v", "data", { signed: true });
      return c.text("set");
    });
    const set = await app.handle(req("/set"));
    const cookieLine = (set.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "v=";
    const value = cookieLine.slice(cookieLine.indexOf("=") + 1);
    expect(value.includes(".")).toBe(true); // carries a signature
    const ok = await app.handle(req("/read", { headers: { cookie: `v=${value}` } }));
    expect(await ok.text()).toBe("v=data");
    const forged = `v=${value.slice(0, value.indexOf("."))}.forgedsig`;
    const bad = await app.handle(req("/read", { headers: { cookie: forged } }));
    expect(await bad.text()).toBe("v=BAD");
  });

  it("status getter observes committed responses (middleware observability)", async () => {
    const app = createApp(quiet);
    const seen: number[] = [];
    app.use(async (c, next) => {
      await next();
      seen.push(c.status);
    });
    app.get("/x", (c) => c.json({ ok: true }, 201));
    const res = await app.handle(req("/x"));
    expect(res.status).toBe(201);
    expect(seen).toEqual([201]);
  });

  it("mounted routers keep sub-router middleware ahead of route handlers", async () => {
    const app = createApp(quiet);
    const sub = createRouter();
    sub.use(async (c, next) => {
      c.set("X-Sub", "1");
      await next();
    });
    sub.get("/leaf", (c) => c.text("leaf"));
    app.mount("/sub", sub);
    const res = await app.handle(req("/sub/leaf"));
    expect(await res.text()).toBe("leaf");
    expect(res.headers.get("x-sub")).toBe("1");
  });

  it("html escapes interpolations; raw() and arrays compose", () => {
    expect(html`<p>${"<b>&"}</p>`).toBe("<p>&lt;b&gt;&amp;</p>");
    expect(html`<p>${raw("<b>")}</p>`).toBe("<p><b></p>");
    expect(html`<p>${["a", "<i>"]}</p>`).toBe("<p>a&lt;i&gt;</p>");
    expect(html`<p>${null}${undefined}${0}</p>`).toBe("<p>0</p>");
  });

  it("sugar responses consume staged headers exactly once (rule-4 containment)", async () => {
    const app = createApp(quiet);
    app.get("/x", (c) => {
      c.set("X-Staged", "1");
      return c.json({ ok: true }, 201, { "X-Call": "2" });
    });
    app.use(async (c, next) => {
      await next();
      c.set("X-Post", "3"); // post-commit write merges, does not duplicate
    });
    const res = await app.handle(req("/x"));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-staged")).toBe("1");
    expect(res.headers.get("x-call")).toBe("2");
    expect(res.headers.get("x-post")).toBe("3");
  });
});
