# bun-koa v2

**High-performance onion-model web framework for [Bun 1.4+](https://bun.sh).**
Hono's speed and feature surface, Koa's middleware ergonomics — one flat
context per request, top-level routing, precompiled middleware chains, and a
bare-`Response` fast path. Zero runtime dependencies; the core is
runtime-free and also runs under Node for testing.

**In-process throughput vs Hono (Bun 1.4, Apple Silicon): text 1.08x, param
routes 1.04x** — while carrying lazy content negotiation, signed cookies,
405/Allow synthesis and the full onion model. See `bench/BENCH.md`.

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

| Member                                                                         | Description                                                                                                                 |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `createApp(options?)`                                                          | Factory (no classes anywhere). Options: `keys`, `proxy`, `proxyIpHeader`, `maxIpsCount`, `subdomainOffset`, `env`, `silent` |
| `app.use(...mw)`                                                               | Global middleware, compiled into every route chain (late `use` recomposes)                                                  |
| `app.get/post/put/patch/delete/head/options/all(path, ...handlers)`            | Route registration; named form `app.get(name, path, ...handlers)`                                                           |
| `app.on(method, path, ...handlers)`                                            | Any method, any case                                                                                                        |
| `app.mount(prefix, routerOrApp)`                                               | Table-merge mount (404s fall through); sub-app global middleware is prepended                                               |
| `app.param(name, mw)`                                                          | Middleware for every route capturing that param                                                                             |
| `app.handle(request, runtime?)`                                                | Fetch-style handler; `runtime = { server?, remote?, env? }` feeds `c.ip` and websocket upgrades                             |
| `app.listen(port?, host?, cb?)`                                                | Boots `Bun.serve`; returns the Bun `Server` (with `reload()`)                                                               |
| `app.onError(fn)` / `app.notFound(fn)`                                         | Error subscription and custom 404; `silent`/`env: "test"` suppress default logging                                          |
| `app.decorate(key, value)`                                                     | Extend every context (setup time)                                                                                           |
| `app.redirect(src, dest, code?)` / `app.url(name, params)` / `app.route(name)` | Redirect routes and named-URL building                                                                                      |
| `app.callback()`, `app.toJSON()`                                               | Adapters and introspection                                                                                                  |

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
built into dispatch — no `allowedMethods()` middleware needed.

## Quality gates

```bash
bun run test        # vitest (also runs under Node)
bun run coverage    # >90% thresholds on statements/branches/functions/lines
bun run lint        # oxlint (max-lines 500 enforced)
bun run fmt         # oxfmt
bun run typecheck   # TypeScript 7 native (tsc --noEmit)
bun run smoke       # boots a real Bun.serve and exercises every critical path
bun run soak        # memory-leak soak: 1.2M+ requests, heap must stabilize
bun run bench       # koa vs hono vs bun-koa benchmark
```

- 928 tests green on **both Node and Bun runtimes**, including:
  - `test/koa-parity.test.ts` — behavior-equivalent ports of koa 3.2.1's
    official suite, verified against the koa sources (JSON `null` bodies,
    `Blob`/web-`Response` bodies, query rewrite, redirect-back, teapots…)
  - `test/security.test.ts` — injection / pollution / disclosure / abuse cases
  - `test/official-parity.test.ts` — ports of assertions from the **official
    repos** (koa@3.2.1 `__tests__`, cloned source), covering the Koa behaviors
    listed below

**Exhaustive parity audit** — every one of the **562 official test cases** in
koa@3.2.1 (`__tests__`) and @koa/router@13 (`test/`) was classified; 528 are
verified by bun-koa's suite, 26 are inapplicable to the fetch model (reasons
per case in [docs/PARITY.md](docs/PARITY.md)). This pass surfaced and fixed
three more Koa behaviors: `ctx.back()` (same-origin referrer redirect),
`response.is()` (with `.ext` and `*/subtype` matching) and type-is returning
the caller's original form.

**Verified against the official koa 3.2.1 test suite** (cloned from
`koajs/koa`, `.parity/`): onerror header reset, `err.statusCode`, `ctx.set({})`,
`ctx.type` shorthand expansion (`'json'` → `application/json; charset=utf-8`),
empty-status content-header stripping, `attachment` with GHSA-c5vw-j4hf-j526
(Content-Type never overridden), basename handling, `?` non-ASCII fallback and
`type: 'inline'`, `ctx.search=` / `ctx.querystring=` setters, `req.URL`,
extension-based `accepts('png')`, `ctx.toJSON()`, `app.context` /
`app.request` / `app.response` extension layers, and opt-in
`app.currentContext` (AsyncLocalStorage — off by default: it costs ~30%
throughput on Bun).

Node-specific Koa features intentionally not ported (no `req`/`res` objects in
the fetch model): `ctx.respond = false`, `flushHeaders()`, `res.writable` /
`res.socket`, HTTP/2 `:authority`, custom status codes outside 200-599, and
raw Node stream lifecycle management.

- Memory soak: 8x150k in-process + 4x20k live HTTP requests across every path
  (text, JSON, params, cookies, errors, redirects) — heap drift < 0.5%,
  no leaks

- 928 tests green on **both Node and Bun runtimes**
- Coverage ≥ 90% on all four metrics (98 / 90 / 98 / 99)
- Every file ≤ 500 lines, enforced by oxlint `max-lines`
- Functional style only: factories + closures, zero `class`

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
  application/  app, compose (precompiled onion), respond, emitter
  context/      context facade, cookies + signing
  http/         request, response facades, status table, error factory
  negotiation/  accepts/* with q-values, type-is
  router/       static Map + pattern trie + router factory
  adapters/     Bun.serve glue (injectable for tests)
  utils/        url/query/text/mime helpers
```

MIT license. Requires Bun ≥ 1.4.
