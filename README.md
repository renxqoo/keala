# Keala

English | [简体中文](./README.zh-CN.md)

**The web framework that gives you Koa's ergonomics and Hono's speed — in one
context, on [Bun 1.4+](https://bun.sh), with zero dependencies.**

```bash
bun add keala
```

## Quick Start

```ts
import { Keala } from "keala";

const app = new Keala();

app.get("/", (c) => c.text("hello keala")); // hono-style return
app.get("/users/:id(\\d+)", (c) => c.json({ id: c.params.id }));
app.get("/page", (c) => {
  // koa-style state
  c.type = "text/html";
  c.body = "<b>hi</b>";
});

app.listen(3000);
```

Routers group and mount by table merge (unmatched paths fall through to the
parent app — no swallowed 404s):

```ts
import { Router } from "keala";

const api = new Router({ prefix: "/v1" });
api.param("oid", async (c, next) => {
  /* org guard */ await next();
});
api.get("/orgs/:oid", (c) => c.text("org"));

app.mount("/api", api);
```

Runs under Node too — same app, one import:

```ts
import { listen } from "keala/node";
listen(app, 3000);
```

## Why keala

- **Hono-class speed.** ABAB-interleaved HTTP benchmarks put keala at
  statistical parity with Hono (every ratio inside run noise) and
  **3.0–3.5x faster than Koa 3** — 15x at 1000 routes — at the lowest peak
  memory of the compared JS frameworks, while carrying lazy content
  negotiation, signed cookies, 405/Allow synthesis and the full onion model.
  Chains are compiled once at registration; fully-sync middleware paths run
  with zero promise allocations; routing happens before the onion (static =
  one `Map` hit).
- **Both API styles, one flat context.** `return c.json(...)` (hono) and
  `c.body = ...; c.status = 404` (koa) mix freely — the last committer wins.
  Every request allocates exactly one context object; `query`, `cookies`,
  `ip`, `state` materialize on first touch.
- **Zero runtime dependencies.** Everything is built in: CORS, CSRF, auth,
  ETag, compression, static files, SSE, body parsing, validation (Standard
  Schema), WebCrypto password hashing, signed cookies with key rotation.
- **Bun-native superpaths.** `app.sink()` serves static routes straight from
  Bun's native routing table (zero JS per request) mirrored as ordinary
  routes; `serveStatic` uses `Bun.file` sendfile; WebSockets upgrade through
  the native socket; `streamSSE` applies Bun's official idle-timeout remedy.
- **Battle-tested.** **1800+ tests green under both Node and real Bun
  runtimes** (91 files), hardened against real-world attack patterns
  (injection, prototype pollution, request smuggling, abuse), and behavior
  verified side-by-side against koa and hono themselves. Every change
  passes four quality gates: format, lint, types, and the full test suite
  on both runtimes.
- **Security-first defaults.** CRLF/NUL and CTL rejection on header writes,
  prototype-pollution-proof query/cookie maps, RFC 6265 cookie validation,
  timing-safe signed-cookie comparison, `expose` semantics that never leak
  stack traces in production, double-budgeted form parsing (bytes AND parts).

A Go `net/http` reference ships in the harness: on the comparison box Go
leads every JS runtime (raw Bun.serve included) by ~10–15% on throughput and
decisively on memory — the gap is the runtime's HTTP stack, not framework tax
(keala adds nothing on top of it versus hono). See `bench/BENCH.md`.

## Middleware, plugins & helpers

Three lifecycles, one `app.use()` entry. **Only middleware and adapters are
split out** — the middleware tier is the heavy one (~2.7MB when loaded) and
adapters are a mutually exclusive runtime choice, so they live at their own
subpaths while the root stays the one-import app surface:

| Entry                   | What it gives you                                                                                          | Loads               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------- |
| `keala`                 | Keala / Router / compose / Context / errors / cookies / bodyParser / helpers / HTTP & fs safety primitives | the app surface     |
| `keala/middleware`      | every middleware factory in one import                                                                     | the middleware tier |
| `keala/middleware/cors` | one factory                                                                                                | that file only      |
| `keala/node`            | the Node listener (bun/node are exclusive)                                                                 | that file only      |

- **middleware** — per-request pipeline functions: `app.use(cors())`
- **plugins** — setup-time installers (`install(app)`), decorate contexts: `app.use(createBodyParser())`
- **helpers** — called inside handlers: `streamSSE(c, ...)`, `hashPassword(pw)`

```ts
import {
  cors,
  csrf,
  csrfToken,
  csrfTokenGuard,
  basicAuth,
  bearerAuth,
  etag,
  compress,
  secureHeaders,
  timing,
  requestId,
  logger,
  bodyLimit,
  noOpFor,
  rateLimit,
  timeout,
  serveStatic,
  validator,
} from "keala/middleware"; // the aggregate — or per file: keala/middleware/cors
import { createBodyParser, hashPassword, verifyPassword, streamSSE, html, raw } from "keala";

app.use(createBodyParser({ jsonLimit: 1024 * 1024 })); // PLUGIN: installs c.req.json()/text()/formData()…
// formData() is double-budgeted: formLimit bytes AND formPartLimit parts
// (default 1000 — thousands of tiny parts are a memory-amplification
// vector a byte cap alone does not stop).
app.use(cors({ origin: ["https://app.site"], allowCredentials: true }));
app.use(secureHeaders());

// Zero-dependency observability: per-key rate limiting and Prometheus metrics
app.use(rateLimit({ limit: 100, windowMs: 60_000 })); // 429 + Retry-After
const m = metrics(); // counters by status class, in-flight gauge, duration buckets
app.use(m.middleware);
app.get("/metrics", m.page); // Prometheus text exposition

app.post("/users", validator(schema), (c) => c.json(c.valid)); // Standard Schema
app.get("/feed", (c) =>
  streamSSE(c, async (sse) => {
    sse.send({ data: tick() });
  }),
);
app.get("/page/:slug", (c) => c.html(html`<h1>${c.params.slug}</h1>`)); // auto-escaped
app.ws("/chat", {
  open(ws) {
    /* native Bun socket */
  },
  message(ws, data) {},
});
```

## Bun-native fast paths (P3)

```ts
// app.sink() — served from Bun's native routing table (zero JS per
// request), mirrored as ordinary routes so app.handle() works everywhere.
// Param middleware always refuses to sink; global/scoped middleware must be
// excused with a noOpFor() transparency declaration (sink() and app.use()
// enforce that loudly). Sinking is a Bun-native optimization — on Node the
// mirror serves it identically but slower, so Node deployments should not
// sink hot routes.
app.sink("/health", new Response("ok")); // static response, reused natively
app.sink("/users/:id", (request, params) => new Response(`user ${params["id"]}`)); // function sink: no middleware or
// context — just (request, params) → Response; errors answer through the
// builtin funnel (app.onError() and function sinks refuse each other)
app.sink("/assets/*", { dir: "./public" }); // directory tree (index/Range)
app.use(noOpFor(bodyLimit(1024 * 1024), { bodyless: true })); // declared
// transparent for GET/HEAD — allowed alongside sinks; the JS mirror
// still runs it, only the native table skips it
app.listen({ port: 3000 }); // routes table embedded at boot
app.sink("/ping", new Response("pong")); // later sink → server.reload()
app.reloadNativeRoutes(); // or rebuild the table explicitly

// Passwords: WebCrypto PBKDF2-SHA-256 default (portable across Bun/Node —
// Bun 1.4.0's own Bun.password.verify and node:crypto.scrypt are broken on
// some platforms). bunPasswordHasher() opts into argon2id explicitly.
const hash = await hashPassword(pw); // pbkdf2$600000$…
await verifyPassword(hash, pw); // true/false, fails closed on corrupt data

// Signed CSRF tokens: Bun.CSRF natively, HMAC fallback on Node.
const tokens = csrfToken({ secret: process.env.CSRF_SECRET! });
app.use(csrfTokenGuard({ service: tokens, sessionId: (c) => sessionCookie(c) }));
app.get("/form", (c) => c.html(formWithHidden(tokens.issue(sessionCookie(c)))));
```

| `basicAuth` / `bearerAuth` middleware parse and challenge (RFC 7617/6750);
verification always delegates to your `verify` callback. `serveStatic`
bodies are `new Response(Bun.file(path))` under Bun (sendfile, auto
Content-Length, Range) and buffered under Node. `streamSSE` disables the
per-request idle timeout via `server.timeout(req, 0)` — Bun's official SSE
remedy — on top of the heartbeat.

### Reading request bodies

`c.raw` **is** the standard web `Request` — with zero setup:

```ts
app.post("/echo", async (c) => {
  const text = await c.raw.text(); // or .json(), .arrayBuffer(), .formData()
  return c.text(text.toUpperCase());
});
```

Each call consumes the underlying stream — read once per request. The
`createBodyParser` plugin upgrades every handler with a memoized,
size-bounded reader instead: `c.req.json()` / `c.req.text()` /
`c.req.formData()` answer 413 over the limit, exposed 400 on malformed
input, and double-budget forms (bytes AND parts). `readBodyLimited` is the
one-shot bounded helper underneath, exported for custom readers.

### HTTP & fs safety primitives

The audited semantics behind `serveStatic` are public API — file-backed
products consume one implementation instead of re-deriving it:

```ts
import { weakEtag, isNotModified, resolveRelativeSegments, isWithinRoot, findSymlink } from "keala";

const segments = resolveRelativeSegments(path, sep === "\\"); // segment → decode → normalize; null = refuse
const absolute = resolve(root, segments.join("/"));
if (!isWithinRoot(absolute, root, sep)) c.throw(403);
if ((await findSymlink(root, absolute)) !== null) c.throw(403); // first symlink component, or null

const etag = weakEtag(stat.size, stat.mtimeMs); // W/"<size-hex>-<mtime-hex>"
if (
  isNotModified({
    etag,
    mtimeMs: stat.mtimeMs,
    ifNoneMatch: c.get("if-none-match"),
    ifModifiedSince: c.get("if-modified-since"),
  })
) {
  return new Response(null, { status: 304 });
}
```

| Component                             | Highlights                                                                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBodyParser`                    | one bounded memoized read; every reader re-validates ITS limit (413); malformed JSON/formData → exposed 400                                                                                                                       |
| `validator`                           | Standard Schema (zod 4 / valibot / typebox); issues → 400; result on `c.valid`                                                                                                                                                    |
| `cors` / `csrf`                       | credentials require an origin whitelist; reflected origins always carry `Vary: Origin` (a constant `*` answer doesn't — it never varies); `Origin: null` rejected; genuine preflights (with `Access-Control-Request-Method`) only |
| `etag` / `compress`                   | weak tags + 304 (If-None-Match precedence per RFC 9110); async gzip, injected for tests                                                                                                                                           |
| `serveStatic`                         | decode → normalize → containment; null bytes 400; ANY symlink component denied (dirs included); index containment re-checked                                                                                                      |
| `streamSSE` / `stream` / `streamText` | CRLF/CR-sanitized frames, heartbeat vs Bun's 10s idle timeout, `onAbort`, backpressure signal                                                                                                                                     |
| `html` + `raw()`                      | tag-template escaping; trust marker is a Symbol — unforgeable through JSON                                                                                                                                                        |
| `bodyLimit` / `timeout`               | declared-length fast 413; wall-clock 504 with floating-promise containment                                                                                                                                                        |
| `app.ws`                              | native `server.upgrade`; events dispatched per route with the request context                                                                                                                                                     |

## The context: one flat object

Every request allocates exactly one context. Request and response live on the
same object; everything lazy (`query`, `cookies`, `ip`, `state`) materializes
on first touch.

| Request side (read-only)                                          | Response side                             | Sugar (return style)             |
| ----------------------------------------------------------------- | ----------------------------------------- | -------------------------------- |
| `c.raw/method/path/url/querystring/search`                        | `c.status/body/type/length`               | `c.text(str, status?, headers?)` |
| `c.get(name)` / `c.header(name)`                                  | `c.setHeader/append/remove/has/resHeader` | `c.json(obj, status?, headers?)` |
| `c.params` `c.query(name)` `c.queries(name)` `c.ip/host/protocol` | `c.etag/lastModified/attachment/redirect` | `c.html(str, status?, headers?)` |
| `c.accepts/is` `c.signal` `c.runtime`                             | `c.cookies` (signed, key rotation)        | `c.throw/assert`                 |

Dual-mode rules in one line each: **a returned `Response` commits; `c.*`
writes are staged; the last committer wins; untouched requests hit
`app.notFound`**. Once committed, header writes still decorate the committed
Response (`c.setHeader/append/remove` keep working after `await next()`),
while `c.body/c.status/c.redirect` throw — return a new Response to replace
a committed one (the full contract: `docs/MIGRATION-0.7.md`). A matched path without the method answers 405 + `Allow`
(OPTIONS gets 200 + `Allow`, unknown methods 501).

`c.query(name)` is a TARGETED read (0.6.2): it returns the first value for
`name` (`undefined` when absent; a bare trailing key reads as `""`), decoded
with `+` → space and `%XX`, malformed escapes verbatim. `c.queries(name)`
collects every repeat. There is no full map — building one cost ~111ns per
request while a boundary-matched scan costs ~2ns, and the property form
`c.query.name` cannot be lazier than the object it reads. Enumeration needs:
`c.querystring` (the raw string). Keys match in raw or canonical
encodeURIComponent form; non-canonical encoding of unreserved characters
(`%5F` for `_`) is not decoded on the match path.

## Global middleware and routing order — the #1 trap

Routing happens **before** the onion, but global `app.use()` middleware wraps
**every route's handlers** (koa semantics): a middleware that returns a
Response without calling `next()` keeps the route from ever running — the
`/health` below answers the middleware's 404, never its own handler:

```ts
app.use(markdown()); // serves files; 404s on a miss without calling next()
app.get("/health", (c) => c.text("ok")); // never runs
```

Two supported shapes for "handle everything else":

- **global middleware that declines**: call `next()` for every request you
  don't handle — the keala contract for `app.use()` middleware;
- **a wildcard route**: explicit routes beat the wildcard, so order stops
  mattering:

```ts
app.get("/health", (c) => c.text("ok"));
app.get("/*", markdownHandler); // only what nothing else claimed
```

Middleware that belongs to one static path or subtree can be scoped at setup:

```ts
app.use("/oauth/*", auth()); // matches /oauth itself and descendants
app.use("/health", probeHeaders()); // exact path only
```

Scoped layers keep registration order and still run for in-scope 404/405/
automatic OPTIONS responses. Registered routes outside the scope pay no
request-time prefix check: applicable layers are selected while chains are
compiled. Scope patterns are deliberately limited to static exact paths and
a final standalone `/*`; params/regex/infix wildcards throw at registration.

In `env: "development"`, keala warns when a matched route never ran because a
middleware stopped the chain — one line per (method, path), zero overhead in
production (rules: `DESIGN.md` §2 in the [repo](https://github.com/renxqoo/keala)).

## Migrating from koa

| Koa                                                     | keala                                                   |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `ctx.request.get("x")`                                  | `c.get("x")`                                            |
| `ctx.response.set("x", v)` / `ctx.set(...)`             | `c.setHeader("x", v)`                                   |
| `ctx.body = x` / `ctx.status = n`                       | `c.body = x` / `c.status = n` (same)                    |
| `ctx.throw(404, "msg")` / `ctx.assert(...)`             | `c.throw(404, "msg")` / `c.assert(...)`                 |
| `app.use(router.routes()).use(router.allowedMethods())` | `app.get(...)` directly, or `app.mount(prefix, router)` |
| `new Koa({ proxy: true })`                              | `new Keala({ proxy: true })`                            |
| `ctx.state.user`                                        | `c.state.user` (same)                                   |
| `ctx.cookies.get/set`                                   | `c.cookies.get/set` (same, signed + keys)               |

Deliberate divergences (see `PARITY.md` in the [repo](https://github.com/renxqoo/keala)): string bodies carry no
framework-set `content-type` (the runtime provides `text/plain`; use `c.type`
or the sugar for explicit types); markup sniffing is gone; object bodies keep
their object shape on `c.body` reads.

## Migrating from hono

| Hono                                               | keala                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `new Hono()`                                       | `new Keala()`                                                                                              |
| `app.get(path, (c) => c.json(...))`                | the same return style                                                                                      |
| `c.req.param("id")`                                | `c.params.id`                                                                                              |
| `c.req.query("q")`                                 | `c.query("q")` (identical idiom; `c.queries("q")` for repeats)                                             |
| `c.req.header("x")`                                | `c.get("x")`                                                                                               |
| `await c.req.json()`                               | `await c.raw.json()` (zero setup) or the parser plugin's `c.req.json()`                                    |
| `app.use(mw)`                                      | the same — plus a [dev warning](#global-middleware-and-routing-order--the-1-trap) when it swallows a route |
| `app.notFound(fn)` / `app.onError(fn)`             | `app.notFound(fn)` / `app.onError(fn)`                                                                     |
| `hono.route("/api", subApp)`                       | `app.mount("/api", router)` (table merge; 404s fall through)                                               |
| `app.fetch(req)` → `Response \| Promise<Response>` | `await app.handle(req)` → always `Promise<Response>`, never rejects                                        |
| `Bun.serve({ fetch: app.fetch })`                  | `app.listen(port)` — Bun.serve baked in                                                                    |
| `new Hono({ strict: false })`                      | no strict mode: `/path` and `/path/` are the same route                                                    |
| `new URL(c.req.url())`                             | `c.url` is path+search (koa form); the absolute URL is `c.raw.url`                                         |
| `app.onError(fn)` shapes the error response        | the same return-a-Response contract — plus void = built-in (decline)                                       |
| `app.notFound(fn)` may throw                       | must `return` a Response — a throw answers the generic 500 path                                            |

Divergences worth knowing: `c.body` is the **response** body (hono's request

## Error handling: onError, notFound

`app.onError(mapper)` is the **single** error entry (one slot — a second
registration throws):

```ts
app.onError((error, c) => {
  // side effects ARE the observation story — log/report here
  if (error.status >= 500) logger.error({ err: error.stack, url: c.url });
  // return a Response to take over the error response…
  return c.json({ error: { code: error.code ?? `HTTP_${error.status}` } }, error.status);
  // …or return nothing to keep keala's built-in response
});
```

- The mapper **always** receives an `HttpError` (`status`/`expose`/`code`/
  `headers`); plain throwables are classified in place as an unexposed 500 —
  internal messages never leak unless you opt in (`expose: true`).
- A takeover Response keeps its own headers; `error.headers`
  (e.g. `WWW-Authenticate`) and staged security headers are merged only into
  absent slots. Immutable runtime Responses are rebuilt once when a merge is
  required; HEAD bodies are stripped.
- The funnel covers **everything**: handler/middleware throws, `c.throw`,
  finalize failures (unserializable bodies) and ws upgrade rejections.
- A failing mapper answers the static 500 and the framework console.errors
  the mapper bug — envelope bugs are never silent. Only `undefined` declines;
  any other non-Response return is treated as the same loud mapper failure.
- No mapper registered + 5xx + non-test env keeps the framework console
  fallback; register `app.onError(() => {})` to silence it explicitly.
- `app.notFound(fn)` must **return** a Response. It runs inside the
  finalizer; a throw there lands in the generic error path.
  body lives on `c.raw` or the parser plugin); middleware runs koa-style — see
  [Global middleware and routing order](#global-middleware-and-routing-order--the-1-trap).

## Why it's fast

| Koa (Node)                                        | keala (Bun)                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Recompiles dispatch closure **per request**       | Chain compiled **once** at registration time                                                    |
| Every middleware hop wrapped in `Promise.resolve` | Fully-sync chains run with **zero promise hops** (one settled promise at the `handle` boundary) |
| `req`/`res` objects + header re-serialization     | Web `Request`/`Response` passed through natively                                                |
| Eager body/URL work                               | Query, cookies, client IP, `state` are **lazy**                                                 |
| Router regex walk                                 | Static = one `Map` hit; simple params = compiled matcher; everything else = trie                |
| Three context objects per request                 | **One** flat context object                                                                     |
| Router runs as an onion layer                     | Routing happens **before** the chain (hono model)                                               |
| Response rebuilt with header maps                 | Bare `new Response(body)` fast path; `Response.json` for objects                                |

## API

### Application

| Member                                                                         | Description                                                                                                                                                     |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Keala(options?)`                                                          | The app class (koa-style `new`). Options: `keys`, `proxy`, `proxyIpHeader`, `maxIpsCount`, `env`                                                                |
| `app.use(...mw)`                                                               | Global middleware, compiled into every route chain (late `use` recomposes)                                                                                      |
| `app.use(path, ...mw)`                                                         | Exact static or trailing-`/*` scoped middleware; applies to in-scope 404/405 too                                                                                |
| `app.get/post/put/patch/delete/head/options/all(path, ...handlers)`            | Route registration; named form `app.get(name, path, ...handlers)`                                                                                               |
| `app.on(method, path, ...handlers)`                                            | Any method, any case                                                                                                                                            |
| `app.mount(prefix, routerOrApp)`                                               | Table-merge mount (404s fall through); applicable sub-app global/scoped middleware is prepended                                                                 |
| `app.param(name, mw)`                                                          | Middleware for every route capturing that param                                                                                                                 |
| `app.handle(request, runtime?)`                                                | Fetch-style handler → `Promise<Response>`, never rejects; `runtime = { server?, remote?, env? }` feeds `c.ip` and websocket upgrades                            |
| `app.listen(port?, host?, cb?)`                                                | Boots `Bun.serve`; returns the Bun `Server` (with `reload()`); `onServeError` optional override of the 500 handler. Under Node use `listen()` from `keala/node` |
| `app.sink(path, Response \| { dir } \| handler)` / `app.reloadNativeRoutes()`  | Sink static routes into Bun's native routing table; hot-reload the table on a running server                                                                    |
| `app.onError(mapper)` / `app.notFound(fn)`                                     | Single-slot error mapper (`Response \| void`) and custom 404; `env: "test"` suppresses the default console fallback                                             |
| `app.decorate(key, value)`                                                     | Extend every context (setup time; duplicate/core keys throw — no silent shadowing)                                                                              |
| `app.ws(path, handlers)`                                                       | WebSocket route (Bun only; a duplicate path throws at setup)                                                                                                    |
| `app.redirect(src, dest, code?)` / `app.url(name, params)` / `app.route(name)` | Redirect routes and named-URL building                                                                                                                          |
| `app.callback()`, `app.toJSON()`                                               | Adapters and introspection                                                                                                                                      |

### Context

One flat object — request side, response side and sugar share it:

- Request (read-only — the request is the client's fact): `raw method url
path query(name) queries(name) querystring search URL host protocol secure
ip origin href idempotent reqLength headers get/header is accepts
acceptsEncodings params state signal runtime`
- Response: `status body type length etag lastModified attachment
redirect(url, code?) setHeader append remove has resHeader res cookies`
- Sugar: `text/json/html(body, status?, headers?)` — return them straight from
  the handler
- `c.throw(status, msg?, props?)`, `c.assert(cond, status, ...)`

### Cookies

`c.cookies.get(name, { signed })` / `c.cookies.set(name, value, options)` with
`maxAge expires path domain secure httpOnly sameSite partitioned priority
overwrite signed`. Signing is HMAC-SHA256 with key rotation (Keygrip format:
`value.signature`); signed reads fail closed without configured keys.

### Router

`new Router({ prefix })` groups routes for `app.mount`. Patterns: `:name`,
`:name(\\d+)` (custom regex), `:name?` (optional), `*` (wildcard tail).
Matching priority static > param > wildcard; HEAD falls back to GET handlers
(Express-style); 405 + `Allow`, OPTIONS 200, and 501 for unknown verbs are
built into dispatch — no `allowedMethods()` middleware needed. Same-position
params with different custom patterns (`/users/:id(\\d+)/a` next to
`/users/:id/b`) are separate variants — every subtree stays reachable;
conflicting param _names_ at one position still throw at registration.

## Running under Node

The core is fetch-shaped and runtime-free; the official Node adapter lives at
its own subpath so importing the framework never loads the node:http bridge
on Bun:

```ts
import { Keala } from "keala";
import { listen } from "keala/node";

const app = new Keala();
app.get("/", (c) => {
  c.body = "hello";
});
listen(app, 3000, "127.0.0.1", () => console.log("up"));
```

The adapter streams request bodies through (never buffers), pipes responses
with real backpressure, fans out `set-cookie`, answers malformed HTTP with
400, and exposes `port/hostname/stop/fetch/ready()` mirroring the Bun handle
shape. Websockets are Bun-only: `app.ws()` routes answer 501 and raw Upgrade
requests are refused at the wire. Node native modules (crypto/fs) are loaded
lazily everywhere — an idle `import "keala"` costs no bridges (~2.8MB less
RSS on Bun); the crypto bridge loads with the first signed cookie / CSRF
fallback / password verify.

## Quality gates

```bash
bun run test        # vitest (also runs under Node)
bun run coverage    # >90% thresholds on statements/branches/functions/lines
bun run lint        # oxlint (max-lines 500 enforced)
bun run fmt         # oxfmt
bun run typecheck   # TypeScript 7 native (tsc --noEmit)
bun run verify      # all of the above in one gate
bun run smoke       # boots a real Bun.serve and exercises every critical path
bun run soak        # memory soak: in-process + HTTP + concurrent, heap must stabilize
bun run bench       # vs hono / koa / fastify / raw / Go benchmark harness
```

- **1800+ tests green under Node and real Bun runtimes** (91 files,
  `bun run test` + `bun run test:bun`), including:
  - `test/adapters-node.test.ts` — the Node adapter over real sockets in BOTH
    runtimes (bridging, set-cookie fanout, streaming, HEAD, 400/500/501
    failure surfaces)
  - `test/security*.test.ts` + `agent-security-audit` — injection / pollution /
    disclosure / abuse / proxy-trust cases (255+ assertions)
  - `test/redteam*.test.ts` + per-round lock files — regression locks for
    every one of the 85+ defects found and fixed during development, plus
    the `matchRoute ≡ pure trie` equivalence fuzz (100 randomized route
    tables × 120 paths per run)
  - `test/anomalies*.test.ts`, `matrix`, `agent-bugs`, `agent-concurrency*` —
    the full abnormal-input and state-machine matrices ported from the koa corpus
  - `test/parity-security.test.ts` — security-relevant koa parity semantics
    (GHSA-c5vw-j4hf-j526, redirect/back same-origin, expose gate…)
- Coverage thresholds >90% on all four dimensions, enforced by `bun run verify`.
- soak: 480k+ in-process requests, 32k over real HTTP and concurrent floods —
  retained-heap drift ≤ 0.1 B/req (in-process) against a 1500 B budget.

## Security

- Header names/values validated (CRLF/NUL rejection — no response splitting);
  `__proto__`/`constructor`/`prototype` rejected as header names
- Query and cookie maps use protected objects — no prototype pollution
- Cookie values/names validated per RFC 6265 before serialization
- 5xx error messages hidden in responses (`expose` semantics like Koa);
  production `env` never leaks stack traces
- Signed cookies use `timingSafeEqual` comparisons

## Project layout

```
src/
  core/         app, compose (precompiled onion), dispatch, respond, sink, listen
  context/      cookies + HMAC signing
  http/         status table, error factory, conditional-request primitives
  negotiation/  accepts/* with q-values, type-is
  router/       static Map + pattern trie (multi-variant params) + router factory
  middleware/   per-request pipeline factories (16) + index.ts aggregate entry
  plugins/      setup-time installers (body-parser)
  helpers/      in-handler utilities (streams/SSE, html, password)
  adapters/     bun.ts (Bun.serve glue), node.ts (official node:http adapter)
  utils/        url/query/text/mime/path-safety helpers, node-lazy (lazy bridges)
```

MIT license. Primary runtime Bun ≥ 1.4 (also runs under Node via
`keala/node`).
