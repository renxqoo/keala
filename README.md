# bun-koa v2

**High-performance onion-model web framework for [Bun 1.4+](https://bun.sh).**
Hono's speed and feature surface, Koa's middleware ergonomics — one flat
context per request, top-level routing, precompiled middleware chains, and a
bare-`Response` fast path. Zero runtime dependencies; the core is
runtime-free and also runs under Node for testing.

**Performance: statistical parity with Hono** (ABAB-interleaved HTTP ratios
all inside run noise; batch-interleaved in-process baseline ties exactly at
379ns/request) — **3.0–3.5x faster than Koa 3** (15x at 1000 routes), at the
lowest peak memory of the compared JS frameworks, while carrying lazy content
negotiation, signed cookies, 405/Allow synthesis and the full onion model.
A Go `net/http` reference is included in the harness: on the comparison box
Go leads every JS runtime (raw Bun.serve included) by ~10–15% on throughput
and decisively on memory — the gap is the runtime's HTTP stack, not
framework tax (bun-koa adds nothing on top of it versus hono).
See `bench/BENCH.md`.

```bash
bun add bun-koa
```

```ts
import { createApp } from "bun-koa";

const app = createApp({ keys: ["signing-secret"] });

// Global onion middleware — compiled into every route chain once
app.use(async (c, next) => {
  const start = Date.now();
  await next();
  c.set("X-Response-Time", `${Date.now() - start}ms`);
});

// Return style (hono-like): fastest path
app.get("/users/:id(\\d+)", (c) => c.json({ id: c.params.id }));

// State style (koa-like): c.body / c.status / c.set
app.get("/page", (c) => {
  c.type = "text/html";
  c.body = "<b>hi</b>";
});

app.listen(3000);
```

Route groups mount by table merge (404s fall through to the parent):

```ts
import { createRouter } from "bun-koa";

const api = createRouter({ prefix: "/v1" });
api.param("oid", async (c, next) => {
  /* org guard */ await next();
});
api.get("/orgs/:oid", (c) => c.text("org"));

app.mount("/api", api);
```

## Middleware, plugins & helpers

Three lifecycles, one `app.use()` entry:

- **middleware** — per-request pipeline functions: `app.use(cors())`
- **plugins** — setup-time installers (`install(app)`), decorate contexts: `app.use(createBodyParser())`
- **helpers** — called inside handlers: `streamSSE(c, ...)`, `hashPassword(pw)`

```ts
import {
  createBodyParser,
  validator,
  cors,
  csrf,
  csrfToken,
  csrfTokenGuard,
  basicAuth,
  bearerAuth,
  hashPassword,
  verifyPassword,
  etag,
  compress,
  secureHeaders,
  timing,
  requestId,
  logger,
  bodyLimit,
  timeout,
  serveStatic,
  streamSSE,
  html,
  raw,
} from "bun-koa";

app.use(createBodyParser({ jsonLimit: 1024 * 1024 })); // PLUGIN: installs c.req.json()/text()/formData()…
// formData() is double-budgeted: formLimit bytes AND formPartLimit parts
// (default 1000 — thousands of tiny parts are a memory-amplification
// vector a byte cap alone does not stop).
app.use(cors({ origin: ["https://app.site"], allowCredentials: true }));
app.use(secureHeaders());

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
// Requires an app without global/param middleware (the native table
// bypasses them — sink() and app.use(fn) enforce that loudly).
app.sink("/health", new Response("ok")); // static response, reused natively
app.sink("/assets/*", { dir: "./public" }); // directory tree (index/Range)
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

`basicAuth`/`bearerAuth` middleware parse and challenge (RFC 7617/6750);
verification always delegates to your `verify` callback. `serveStatic`
bodies are `new Response(Bun.file(path))` under Bun (sendfile, auto
Content-Length, Range) and buffered under Node. `streamSSE` disables the
per-request idle timeout via `server.timeout(req, 0)` — Bun's official SSE
remedy — on top of the heartbeat.

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

| Request side                                  | Response side                                  | Sugar (return style)             |
| --------------------------------------------- | ---------------------------------------------- | -------------------------------- |
| `c.raw/method/path/url/query`                 | `c.status/body/message/type/length`            | `c.text(str, status?, headers?)` |
| `c.get(name)` / `c.header(name)`              | `c.set/append/remove/vary/has/resHeader`       | `c.json(obj, status?, headers?)` |
| `c.params` `c.query` `c.ip/ips/host/hostname` | `c.etag/lastModified/attachment/redirect/back` | `c.html(str, status?, headers?)` |
| `c.accepts*/is/fresh/stale/charset`           | `c.cookies` (signed, key rotation)             | `c.throw/assert`                 |

Dual-mode rules in one line each: **a returned `Response` commits; `c.*`
writes are staged; the last committer wins; untouched requests hit
`app.notFound`**. A matched path without the method answers 405 + `Allow`
(OPTIONS gets 200 + `Allow`, unknown methods 501).

## Migrating from v1 / koa

| v1 (koa-style)                                          | v2                                                      |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `ctx.request.get("x")`                                  | `c.get("x")`                                            |
| `ctx.response.set("x", v)` / `ctx.set(...)`             | `c.set("x", v)`                                         |
| `ctx.body = x` / `ctx.status = n`                       | `c.body = x` / `c.status = n` (same)                    |
| `ctx.throw(404, "msg")` / `ctx.assert(...)`             | `c.throw(404, "msg")` / `c.assert(...)`                 |
| `app.use(router.routes()).use(router.allowedMethods())` | `app.get(...)` directly, or `app.mount(prefix, router)` |
| `new Koa({ proxy: true })`                              | `createApp({ proxy: true })`                            |
| `ctx.state.user`                                        | `c.state.user` (same)                                   |
| `ctx.cookies.get/set`                                   | `c.cookies.get/set` (same, signed + keys)               |

Deliberate v2 divergences (see `docs/v2-DESIGN.md` §0): string bodies carry no
framework-set `content-type` (the runtime provides `text/plain`; use `c.type`
or the sugar for explicit types); markup sniffing is gone; object bodies keep
their object shape on `c.body` reads.

## Why it's fast

| Koa (Node)                                        | bun-koa v2 (Bun)                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Recompiles dispatch closure **per request**       | Chain compiled **once** at registration time                                     |
| Every middleware hop wrapped in `Promise.resolve` | Fully-sync chains return with **zero promises**                                  |
| `req`/`res` objects + header re-serialization     | Web `Request`/`Response` passed through natively                                 |
| Eager body/URL work                               | Query, cookies, client IP, `state` are **lazy**                                  |
| Router regex walk                                 | Static = one `Map` hit; simple params = compiled matcher; everything else = trie |
| Three context objects per request                 | **One** flat context object                                                      |
| Router runs as an onion layer                     | Routing happens **before** the chain (hono model)                                |
| Response rebuilt with header maps                 | Bare `new Response(body)` fast path; `Response.json` for objects                 |

## API

### Application

| Member                                                                         | Description                                                                                                                                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createApp(options?)`                                                          | Factory (no classes anywhere). Options: `keys`, `proxy`, `proxyIpHeader`, `maxIpsCount`, `subdomainOffset`, `env`, `silent`                                                |
| `app.use(...mw)`                                                               | Global middleware, compiled into every route chain (late `use` recomposes)                                                                                                 |
| `app.get/post/put/patch/delete/head/options/all(path, ...handlers)`            | Route registration; named form `app.get(name, path, ...handlers)`                                                                                                          |
| `app.on(method, path, ...handlers)`                                            | Any method, any case                                                                                                                                                       |
| `app.mount(prefix, routerOrApp)`                                               | Table-merge mount (404s fall through); sub-app global middleware is prepended                                                                                              |
| `app.param(name, mw)`                                                          | Middleware for every route capturing that param                                                                                                                            |
| `app.handle(request, runtime?)`                                                | Fetch-style handler; `runtime = { server?, remote?, env? }` feeds `c.ip` and websocket upgrades                                                                            |
| `app.listen(port?, host?, cb?)`                                                | Boots `Bun.serve`; returns the Bun `Server` (with `reload()`); `onServeError` optional override of the 500 handler. Under Node use `listen()` from `bun-koa/adapters/node` |
| `app.sink(path, Response \| { dir })` / `app.reloadNativeRoutes()`             | Sink static routes into Bun's native routing table; hot-reload the table on a running server                                                                               |
| `app.onError(fn)` / `app.notFound(fn)`                                         | Error subscription and custom 404; `silent`/`env: "test"` suppress default logging                                                                                         |
| `app.decorate(key, value)`                                                     | Extend every context (setup time; duplicate/core keys throw — no silent shadowing)                                                                                         |
| `app.ws(path, handlers)`                                                       | WebSocket route (Bun only; a duplicate path throws at setup)                                                                                                               |
| `app.redirect(src, dest, code?)` / `app.url(name, params)` / `app.route(name)` | Redirect routes and named-URL building                                                                                                                                     |
| `app.callback()`, `app.toJSON()`                                               | Adapters and introspection                                                                                                                                                 |

### Context

One flat object — request side, response side and sugar share it:

- Request: `raw method url path query querystring search originalUrl URL host
hostname protocol secure ip ips subdomains origin href fresh stale idempotent
charset reqType reqLength headers get/header is accepts acceptsEncodings
acceptsCharsets acceptsLanguages params state` (`url`/`path`/`query` are
  settable; rewrites invalidate the caches exactly like koa)
- Response: `status message body type length etag lastModified attachment
redirect back set append remove vary has resHeader cookies`
- Sugar: `text/json/html(body, status?, headers?)` — return them straight from
  the handler
- `c.throw(status, msg?, props?)`, `c.assert(cond, status, ...)`

### Cookies

`c.cookies.get(name, { signed })` / `c.cookies.set(name, value, options)` with
`maxAge expires path domain secure httpOnly sameSite partitioned priority
overwrite signed`. Signing is HMAC-SHA256 with key rotation (Keygrip format:
`value.signature`); signed reads fail closed without configured keys.

### Router

`createRouter({ prefix })` groups routes for `app.mount`. Patterns: `:name`,
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
import { createApp } from "bun-koa";
import { listen } from "bun-koa/adapters/node";

const app = createApp();
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
lazily everywhere — an idle `import "bun-koa"` costs no bridges (~2.8MB less
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

- **1274 tests green under Node and real Bun runtimes** (55 files, `bun run test`
  - `bun run test:bun`), including:
  * `test/adapters-node.test.ts` — the Node adapter over real sockets in BOTH
    runtimes (bridging, set-cookie fanout, streaming, HEAD, 400/500/501
    failure surfaces)
  * `test/security*.test.ts` + `agent-security-audit` — injection / pollution /
    disclosure / abuse / proxy-trust cases (255+ assertions)
  * `test/redteam-v2*.test.ts` — red-team regression locks for 11 confirmed
    bug groups found during the v2 hardening pass, plus the
    `matchRoute ≡ pure trie` equivalence fuzz (100 randomized route tables ×
    120 paths per run)
  * `test/anomalies*.test.ts`, `matrix`, `agent-bugs`, `agent-concurrency*` —
    the full abnormal-input and state-machine matrices ported from v1
  * `test/parity-security.test.ts` — security-relevant koa parity semantics
    (GHSA-c5vw-j4hf-j526, redirect/back same-origin, expose gate…)
- Coverage ≥90% on all four dimensions (currently ~96.7/90.9/95.8/98.4).
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
  core/         app, compose (precompiled onion), dispatch, respond, sink, emitter
  context/      cookies + HMAC signing
  http/         status table, error factory
  negotiation/  accepts/* with q-values, type-is
  router/       static Map + pattern trie (multi-variant params) + router factory
  middleware/   per-request pipeline factories (16)
  plugins/      setup-time installers (body-parser)
  helpers/      in-handler utilities (streams/SSE, html, password)
  adapters/     bun.ts (Bun.serve glue), node.ts (official node:http adapter)
  utils/        url/query/text/mime helpers, node-lazy (lazy built-in bridges)
```

MIT license. Primary runtime Bun ≥ 1.4 (also runs under Node via
`bun-koa/adapters/node`).
