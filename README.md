# Keala

English | [简体中文](./README.zh-CN.md)

**keala's own API: onion-model middleware, zero dependencies, Bun-native
fast paths — hono-class speed in one flat context, on [Bun 1.4+](https://bun.sh).**

```bash
bun add keala
```

## Quick Start

```ts
import { Keala } from "keala";

const app = new Keala();

app.get("/", (c) => c.text("hello keala")); // return style
app.get("/users/:id(\\d+)", (c) => c.json({ id: c.params("id") }));
app.get("/page", (c) => c.html("<b>hi</b>"));

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
- **One flat context, one response style.** Handlers answer by return:
  `return c.text/json/html(body, status?, headers?)`, `return c.redirect(...)`
  or a hand-built `new Response(...)` — the last returned Response wins; a
  chain that returns nothing answers the built-in 404. Every request
  allocates exactly one context object; `query`, `cookies`, `ip`, `state`
  materialize on first touch.
- **Zero runtime dependencies.** Everything is built in: CORS, CSRF, auth,
  ETag, compression, static files, SSE, body parsing, validation (Standard
  Schema), WebCrypto password hashing, signed cookies with key rotation.
- **Bun-native superpaths.** `app.sink()` serves static routes straight from
  Bun's native routing table (zero JS per request) mirrored as ordinary
  routes; `serveStatic` uses `Bun.file` sendfile; WebSockets upgrade through
  the native socket; `streamSSE` applies Bun's official idle-timeout remedy.
- **Battle-tested.** **2000+ tests green under both Node and real Bun
  runtimes**, hardened against real-world attack patterns
  (injection, prototype pollution, request smuggling, abuse), and behavior
  verified side-by-side against hono itself. Every change
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
  rateLimit,
  metrics,
  timeout,
  serveStatic,
  validator,
  validOf,
} from "keala/middleware"; // the aggregate — or per file: keala/middleware/cors
import {
  createBodyParser,
  noOpFor, // root export — a transparency declaration, not middleware tier
  hashPassword,
  verifyPassword,
  streamSSE,
  html,
  raw,
} from "keala";

app.use(createBodyParser({ jsonLimit: 1024 * 1024 })); // PLUGIN: installs body readers via bodyOf(c)
// const body = await bodyOf(c).json() — typed accessor, zero cast; the read
// is memoized and double-budgeted: formLimit bytes AND formPartLimit parts
// (default 1000 — thousands of tiny parts are a memory-amplification
// vector a byte cap alone does not stop).
app.use(cors({ origin: ["https://app.site"], allowCredentials: true }));
app.use(secureHeaders());

// Zero-dependency observability: per-key rate limiting and Prometheus metrics
app.use(rateLimit({ limit: 100, windowMs: 60_000 })); // 429 + Retry-After
const m = metrics(); // counters by status class, in-flight gauge, duration buckets
app.use(m.middleware);
app.get("/metrics", m.page); // Prometheus text exposition

app.post("/users", validator(schema), (c) => c.json(validOf<{ name: string }>(c))); // Standard Schema → typed value
app.get("/feed", (c) =>
  streamSSE(c, async (sse) => {
    sse.send({ data: tick() });
  }),
);
app.get("/page/:slug", (c) => c.html(html`<h1>${c.params("slug")}</h1>`)); // auto-escaped
app.ws("/chat", {
  origin: ["https://app.site"], // Origin checked before upgrade; mismatch → 403
  // (csrf() cannot guard a browser WS handshake — this option can)
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
size-bounded reader instead: `bodyOf(c).json()` / `.text()` /
`.formData()` answer 413 over the limit, exposed 400 on malformed
input, and double-budget forms (bytes AND parts); without the plugin,
`bodyOf(c)` throws a TypeError naming the fix. `readBodyLimited` is the
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
    ifNoneMatch: c.header("if-none-match"),
    ifModifiedSince: c.header("if-modified-since"),
  })
) {
  return new Response(null, { status: 304 });
}
```

| Component                             | Highlights                                                                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBodyParser`                    | one bounded memoized read; every reader re-validates ITS limit (413); malformed JSON/formData → exposed 400                                                                                                                       |
| `validator`                           | Standard Schema (zod 4 / valibot / typebox); issues → 400; typed result via `validOf<T>(c)` (the runtime slot `c.valid` is `unknown` at the type level)                                                                           |
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

| Request side (read-only)                               | Response side                                        | Response sugar (return style)    |
| ------------------------------------------------------ | ---------------------------------------------------- | -------------------------------- |
| `c.raw/method/path/url/querystring/search`             | `c.status` (read-only)                               | `c.text(str, status?, headers?)` |
| `c.header(name)` `c.headers`                           | `c.setHeader/append/remove/has/resHeader`            | `c.json(obj, status?, headers?)` |
| `c.params("id")` `c.routePath/routeName`               | `return c.redirect(url, code?)`                      | `c.html(str, status?, headers?)` |
| `c.query(name)` `c.queries(name)` `c.ip/host/protocol` | `c.cookies` (plugin-installed, signed, key rotation) | `new Response(...)`              |
| `c.accepts/is` `c.signal` `c.runtime`                  | `c.throw/assert`                                     |                                  |

Response rules in one line each: **returning a `Response` commits it —
`c.text/json/html(...)` or `new Response(...)`; the last returned Response
wins; a chain that settles without one answers the built-in 404 (staged
headers still merge onto it)**. Header writes stage until the return
(`c.setHeader/c.cookies` ride into the built Response) and after it land
directly on the committed Response (`c.setHeader/append/remove` keep working
after `await next()`); to replace a committed response, return a new one.
`c.status` is read-only — set a status through the sugar's second parameter
or `new Response(..., { status })` (full contract:
[`docs/KEALA-NATIVE-API-MIGRATION.md`](https://github.com/renxqoo/keala/blob/main/docs/KEALA-NATIVE-API-MIGRATION.md),
in the repo — the npm package ships code only). A matched path without the
method answers 405 + `Allow` (OPTIONS gets 200 + `Allow`, unknown methods
501).

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
**every route's handlers** (the onion model's contract): a middleware that
returns a Response without calling `next()` keeps the route from ever
running — the
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

| Koa                                                     | keala                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ctx.request.get("x")`                                  | `c.header("x")`                                                                 |
| `ctx.response.set("x", v)` / `ctx.set(...)`             | `c.setHeader("x", v)`                                                           |
| `ctx.body = x` / `ctx.status = n`                       | `return c.text/json(x, n)` or `return new Response(x, { status: n })`           |
| `ctx.type = t` / `ctx.length = n`                       | `c.setHeader("Content-Type", t)` / `c.setHeader("Content-Length", "n")`         |
| `ctx.etag = "v1"` / `ctx.lastModified = d`              | `c.setHeader("ETag", '"v1"')` / `c.setHeader("Last-Modified", d.toUTCString())` |
| `ctx.attachment("f.pdf")`                               | `c.setHeader("Content-Disposition", 'attachment; filename="f.pdf"')`            |
| `ctx.redirect(url)`                                     | `return c.redirect(url, code?)`                                                 |
| `ctx.throw(404, "msg")` / `ctx.assert(...)`             | `c.throw(404, "msg")` / `c.assert(...)`                                         |
| `app.use(router.routes()).use(router.allowedMethods())` | `app.get(...)` directly, or `app.mount(prefix, router)`                         |
| `new Koa({ proxy: true })`                              | `new Keala({ proxy: true })`                                                    |
| `ctx.state.user`                                        | `c.state.user` (same)                                                           |
| `ctx.cookies.get/set`                                   | plugin `createCookies({keys})` → same facade                                    |

The response-side mappings are manual on purpose: the old setters did quiet
work (MIME shorthand expansion, ETag quoting, attachment filename encoding)
that `c.setHeader` does not — pass complete values. The sugar covers the
common cases with the right content-type for free.

Deliberate divergences (see `PARITY.md` in the [repo](https://github.com/renxqoo/keala)):
koa's state-style response writers are gone — respond by return, always; a
hand-built `new Response(string)` carries no framework-set `content-type`
(the runtime provides `text/plain`; the sugar sets it explicitly); markup
sniffing never existed here.

One security-relevant difference for koa migrants: koa materializes the full
query map, keala's `c.query(name)` is a targeted scan that matches keys in
their raw or canonical `encodeURIComponent` form. A key sent with
**non-canonical** encoding (`a%5Fb` standing in for `a_b`) is invisible to
`c.query("a_b")` — by design (declared in `PARITY.md`; the full map cost
~111ns per request against a ~2ns scan). If a legacy contract genuinely
needs such keys, parse `c.querystring` yourself — and treat
unexpectedly-encoded keys as hostile.

## Migrating from hono

| Hono                                               | keala                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `new Hono()`                                       | `new Keala()`                                                                                              |
| `app.get(path, (c) => c.json(...))`                | the same return style                                                                                      |
| `c.req.param("id")`                                | `c.params("id")`                                                                                           |
| `c.req.query("q")`                                 | `c.query("q")` (identical idiom; `c.queries("q")` for repeats)                                             |
| `c.req.header("x")`                                | `c.header("x")`                                                                                            |
| `await c.req.json()`                               | `await bodyOf(c).json()` (with the bodyParser plugin) or `await c.raw.json()` (zero setup)                 |
| `c.req.routePath()` (Route Helper)                 | `c.routePath` / `c.routeName` (properties, named routes included)                                          |
| `app.use(mw)`                                      | the same — plus a [dev warning](#global-middleware-and-routing-order--the-1-trap) when it swallows a route |
| `app.notFound(fn)` / `app.onError(fn)`             | `app.notFound(fn)` / `app.onError(fn)`                                                                     |
| `hono.route("/api", subApp)`                       | `app.mount("/api", router)` (table merge; 404s fall through)                                               |
| `app.fetch(req)` → `Response \| Promise<Response>` | `await app.handle(req)` → always `Promise<Response>`, never rejects                                        |
| `Bun.serve({ fetch: app.fetch })`                  | `app.listen(port)` — Bun.serve baked in                                                                    |
| `new Hono({ strict: false })`                      | no strict mode: `/path` and `/path/` are the same route                                                    |
| `new URL(c.req.url())`                             | `c.url` is path+search (origin-form); the absolute URL is `c.raw.url`                                      |
| `app.onError(fn)` shapes the error response        | the same return-a-Response contract — plus void = built-in (decline)                                       |
| `app.notFound(fn)` may throw                       | must not throw — return a Response (or nothing, for the built-in 404); a throw answers the generic 500     |

Divergences worth knowing: there is no response-body property at all —
respond by return (hono's request body lives on `c.raw` or the parser
plugin); global middleware wraps every route, onion-style — see
[Global middleware and routing order](#global-middleware-and-routing-order--the-1-trap).

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
- `c.throw(status, …)` accepts **4xx/5xx only** — an informational or
  redirect status throws a `TypeError` instead of an `HttpError`. A redirect
  is not an error: `return c.redirect(url, code?)` or
  `app.redirect(source, dest, code)` (any 3xx integer is accepted and
  preserved as registered — never silently coerced). `c.assert(cond, …)`
  follows the same rule.
- `app.notFound(fn)` customizes the 404 by returning a Response (returning
  nothing keeps the built-in 404) — but it must not throw: a throw
  there lands in the generic 500 path, losing your custom 404.

## Lifecycle & overload

Self-managed processes get graceful shutdown, admission control and request
deadlines in the core — nothing is delegated to the platform:

```ts
import { Keala } from "keala";

const app = new Keala({
  env: "production",
  requestTimeout: 30_000, // ms, 0 disables: expiry aborts c.signal → 504 funnel
  overload: {
    maxConcurrency: 1000, // in-flight cap (admission runs pre-context)
    maxQueue: 100, // 0 = fail-fast 503 (default); queueing is an opt-in
    queueTimeoutMs: 10_000,
    retryAfterSeconds: 1, // Retry-After on 503s; 0 omits the header
  },
  trustedHosts: ["example.com", "*.example.com"], // forged Host → 403 pre-routing
  unknownMethodAs404: true, // unknown verbs → 404 instead of 501
  onStreamError: (error, c) => log(error, c.path), // observe stream-body failures
});

app.listen({ port: 3000, signals: true }); // SIGTERM/SIGINT → drain; 2nd signal force-closes

app.get("/readyz", (c) => (app.isDraining() ? c.text("draining", 503) : c.text("ready")));
app.onShutdown(async () => {
  await flushMetrics(); // runs post-drain, before close() resolves; failures contained
});

const status = await app.close({ drain: 10_000, shutdownTimeout: 10_000 });
// → { timedOut: false, inFlight: 0 }
```

- `drain` (default 30s; `0` = force now, `Infinity` = wait forever) bounds
  in-flight requests; `shutdownTimeout` (default 10s, `0` disables) bounds
  the `onShutdown` hooks — an over-time hook is logged and shutdown
  continues. `close()` is idempotent (same promise on repeat calls).
- `app.isDraining()` flips the moment `close()` begins — point your readiness
  probe at it; `app.inFlight` is the admitted-and-unsettled count.
- `overload.handler(req, reason)` customizes the 503 (no context exists at
  admission time); `overload.strategy` swaps the whole saturated path —
  `failFastAdmission` / `queueAdmission` (both exported from `keala`) are
  the built-ins.
- `pooling: true` recycles per-request contexts for allocation-sensitive
  embedding only: it is a measured net throughput **loss** today (e2e
  −11% to −38%; `docs/HOTPATH-R4-7-POOLING-AB.md` in the repo) — opt in
  despite the cost, never for speed.
- Full production checklist — shutdown windows vs k8s grace periods,
  transport body caps (Bun 128MB default vs Node's explicit
  `maxRequestBodySize`), retries/circuit-breaking, containers:
  [docs/DEPLOY.md](https://github.com/renxqoo/keala/blob/main/docs/DEPLOY.md).

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

| Member                                                                                            | Description                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Keala(options?)`                                                                             | The app class (instantiated with `new`). Options (10): `proxy`, `proxyIpHeader`, `maxIpsCount`, `env`, `requestTimeout`, `overload`, `trustedHosts`, `unknownMethodAs404`, `pooling`, `onStreamError` (see [Lifecycle & overload](#lifecycle--overload)) |
| `app.use(...mw)`                                                                                  | Global middleware, compiled into every route chain (late `use` recomposes)                                                                                                                                                                               |
| `app.use(path, ...mw)`                                                                            | Exact static or trailing-`/*` scoped middleware; applies to in-scope 404/405 too                                                                                                                                                                         |
| `app.get/post/put/patch/delete/head/options/all(path, ...handlers)`                               | Route registration; named form `app.get(name, path, ...handlers)`                                                                                                                                                                                        |
| `app.on(method, path, ...handlers)`                                                               | Any method, any case                                                                                                                                                                                                                                     |
| `app.mount(prefix, routerOrApp)`                                                                  | Table-merge mount (404s fall through); applicable sub-app global/scoped middleware is prepended                                                                                                                                                          |
| `app.param(name, mw)`                                                                             | Middleware for every route capturing that param                                                                                                                                                                                                          |
| `app.handle(request, runtime?)`                                                                   | Fetch-style handler → `Promise<Response>`, never rejects; `runtime = { server?, remote? }` feeds `c.ip` and websocket upgrades                                                                                                                           |
| `app.listen(port?, host?, cb?)`                                                                   | Boots `Bun.serve`; returns the Bun `Server` (with `reload()`); `onServeError` optional override of the 500 handler. Under Node use `listen()` from `keala/node`                                                                                          |
| `app.sink(path, Response \| { dir } \| handler)` / `app.reloadNativeRoutes()`                     | Sink static routes into Bun's native routing table; hot-reload the table on a running server                                                                                                                                                             |
| `app.onError(mapper)` / `app.notFound(fn)`                                                        | Single-slot error mapper (`Response \| void`) and custom 404; `env: "test"` suppresses the default console fallback                                                                                                                                      |
| `app.decorate(key, value)`                                                                        | Extend every context (setup time; duplicate/core keys throw — no silent shadowing)                                                                                                                                                                       |
| `app.ws(path, handlers)`                                                                          | WebSocket route (Bun only; a duplicate path throws at setup). `origin: string[] \| (c) => boolean` checks the upgrade Origin — mismatch 403                                                                                                              |
| `app.redirect(src, dest, code?)` / `app.url(name, params)` / `app.route(name)`                    | Redirect routes and named-URL building                                                                                                                                                                                                                   |
| `app.close({ drain, shutdownTimeout })`, `app.isDraining()`, `app.inFlight`, `app.onShutdown(fn)` | Graceful shutdown surface — see [Lifecycle & overload](#lifecycle--overload)                                                                                                                                                                             |
| `app.callback()`, `app.toJSON()`                                                                  | Adapters and introspection                                                                                                                                                                                                                               |

Units are not uniform across the surface — check twice: `requestTimeout`,
`overload.queueTimeoutMs`, `rateLimit({ windowMs })`, `cache({ ttl })` and
the `timeout(ms)` middleware count **milliseconds**; `listen({ idleTimeout })`,
the `retryAfterSeconds` knobs (`rateLimit`/`overload`) and cookie `maxAge`
count **seconds**. `bodyLimit(bytes)` and `timeout(ms)` each take a single
positional argument.

### Context

One flat object — request side, response side and sugar share it:

- Request (read-only — the request is the client's fact): `raw method url
path query(name) queries(name) params(name) querystring search URL host
protocol secure ip origin href idempotent reqLength headers header is
accepts acceptsEncodings state signal runtime`
- Response: `status` (read-only — the committed Response's status)
  `redirect(url, code?)` (builds a redirect Response — return it) `setHeader
append remove has resHeader cookies`
- Sugar: `text/json/html(body, status?, headers?)` — return them straight from
  the handler; a hand-built `new Response(...)` commits the same way
- `c.throw(status, msg?, props?)` (4xx/5xx only — see
  [Error handling](#error-handling-onerror-notfound)),
  `c.assert(cond, status, ...)`

### Cookies

`app.use(createCookies({ keys }))` installs `c.cookies` (the plugin
protocol — registration-time install, lazy first touch; apps that never
touch cookies pay nothing). The TYPE merges program-wide the moment the
plugin module is in your program; the RUNTIME member only exists on apps
that installed it — `c.cookies` on an app without the plugin is
`undefined`. `c.cookies.get(name, { signed })` / `c.cookies.set(name, value, options)` with
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
app.get("/", (c) => c.text("hello"));
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

- **2000+ tests green under Node and real Bun runtimes**
  (`bun run test` + `bun run test:bun`), including:
  - `test/integration/node-adapter*.test.ts` — the Node adapter over real
    sockets in BOTH runtimes (bridging, set-cookie fanout, streaming, HEAD,
    400/500/501 failure surfaces)
  - `test/security/*` — injection / pollution / disclosure / abuse /
    proxy-trust cases (255+ assertions)
  - `test/security/*-redteam.test.ts` + per-round lock files — regression
    locks for every one of the 85+ defects found and fixed during
    development, plus the `matchRoute ≡ pure trie` equivalence fuzz
    (100 randomized route tables × 120 paths per run)
  - `test/unit/input-anomalies.test.ts`, the negotiation matrix, fuzz and
    concurrency suites — the full abnormal-input and state-machine matrices
  - `test/parity/hono.test.ts` — behavior verified side-by-side against
    hono (the koa differential suites were retired with the koa-form API;
    koa stays a bench comparison player)
- Coverage thresholds >90% on all four dimensions, enforced by `bun run verify`.
- soak: 480k+ in-process requests, 32k over real HTTP and concurrent floods —
  retained-heap drift ≤ 0.1 B/req (in-process) against a 1500 B budget.

## Security

- Header names/values validated (CRLF/NUL rejection — no response splitting);
  `__proto__`/`constructor`/`prototype` rejected as header names
- Query and cookie maps use protected objects — no prototype pollution
- Cookie values/names validated per RFC 6265 before serialization
- 5xx error messages hidden in responses (`expose` semantics);
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
  middleware/   per-request pipeline factories (19) + index.ts aggregate entry
  plugins/      setup-time installers (body-parser)
  helpers/      in-handler utilities (streams/SSE, html, password)
  adapters/     bun.ts (Bun.serve glue), node.ts (official node:http adapter)
  utils/        url/query/text/mime/path-safety helpers, node-lazy (lazy bridges)
```

MIT license. Primary runtime Bun ≥ 1.4 (also runs under Node via
`keala/node`).
