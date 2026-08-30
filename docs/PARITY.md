# bun-koa v2 — deliberate divergences (supersedes the v1 koa-parity ledger below)

The v2 rewrite intentionally drops the koa three-object context in favor of
one flat context (see docs/v2-DESIGN.md). Semantics that CHANGED on purpose:

| Area                     | v1 (koa-compatible)                                            | v2                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content-type             | auto `text/plain; charset=utf-8` / markup sniff to `text/html` | D1: no framework CT for string bodies (runtime provides `text/plain`); `c.html()`/`c.type` for explicit                                                                         |
| `c.body = object`        | serialized eagerly; getter returns the string                  | stored as object; getter returns the object; `Response.json` finalization                                                                                                       |
| Response sugar           | —                                                              | `c.text/json/html(body, status?, headers?)` return-style; staged `c.status` honored (hono parity)                                                                               |
| Router                   | `app.use(router.routes()).use(allowedMethods())`               | top-level routing; 405/Allow/OPTIONS/501 built into dispatch                                                                                                                    |
| Post-commit writes       | dropped                                                        | rule-4 merge into the committed Response (with content-type preservation)                                                                                                       |
| Floating `next()`        | unhandled rejection risk                                       | silently contained (process-safety; documented)                                                                                                                                 |
| `server.update()`        | fictional API (never existed in Bun)                           | `server.reload()`                                                                                                                                                               |
| Extension layer          | `app.request/response/context` prototypes                      | `app.decorate(key, value)` on a per-app derived prototype                                                                                                                       |
| pooling / currentContext | opt-in                                                         | removed from core (guarded pooling is a P3 component)                                                                                                                           |
| Native route sinking     | —                                                              | `app.sink(path, Response \| { dir })`: JS mirror + Bun `routes` table (P3)                                                                                                      |
| Static file bodies       | buffered `readFile`                                            | `new Response(Bun.file(p))` under Bun (sendfile/auto-CL/Range); buffered under Node                                                                                             |
| SSE idle connections     | heartbeat only                                                 | `streamSSE` also calls `server.timeout(req, 0)` (official remedy); `disableIdleTimeout(c)` exported                                                                             |
| CSRF                     | Origin/Referer only                                            | plus `csrfToken()` (Bun.CSRF native, HMAC fallback) + `csrfTokenGuard` header middleware                                                                                        |
| Password hashing         | —                                                              | `hashPassword`/`verifyPassword` (WebCrypto PBKDF2 default; `bunPasswordHasher()` argon2id opt-in — Bun 1.4.0's native verify + node:crypto.scrypt are broken on some platforms) |
| WS error event           | —                                                              | `ws.error(ws, err, c)` handler wired through the adapter                                                                                                                        |
| Serve error callback     | —                                                              | `Bun.serve({error})` default → app error hook + plain 500; `onServeError` overrides                                                                                             |

Retained koa semantics (locked by tests): onion `await next()`, `c.throw`/
`c.assert`, signed cookies with key rotation, lazy query/cookies/ip, error
contract (expose gate, header reset keeping set-cookie, 5xx message hiding),
status/body state machine (204 coercion, JSON `null` literal, HEAD
Content-Length backfill), url rewrite cache-invalidation chain, proxy trust
gates, content negotiation, attachment GHSA fix, redirect encodeurl+escape.

Still-open divergence: `[T2]` — a `:id(\d+)` route registered before a plain
`:id` route at the same position keeps its regex for both (trie merges param
slots). Locked as a skip in `test/agent-redteam.test.ts`.

Native-sink notes: native entries are emitted as `{ GET: value }` — a bare
key answers POST/DELETE/… with the sunk response on Bun 1.4 (verified by
probe), while the mirror is GET-only; method scoping makes non-GET fall
through to `fetch` where the router answers 405 identically. The `{dir}` JS
mirror keeps serveStatic semantics (symlink denial, ETag/304) while the
native `{dir}` route adds trailing-slash 301s for subdirectories and Range
requests the mirror does not implement — `listen({nativeRoutes: false})`
forces JS-only serving when byte-parity matters more than the fast path
(and stays sticky across later `sink()` calls / `reloadNativeRoutes()`).
Bun 1.4 utility surface deliberately NOT adopted: HTMLRewriter, Glob, Semver,
TOML/YAML/JSON5 parsers, Image, Color, Secrets — app-level tools with no role
in the framework core.

---

# Official test-suite parity matrix

Exhaustive per-file audit against the official suites cloned into `.parity/`:
koa@3.2.1 (`__tests__`), @koa/router@13.0.0 (`test/`), hono@4.13.5 (`src/*.test.ts`).

| Upstream file                      | cases | status | bun-koa verification                                                                                                                                                              |
| ---------------------------------- | ----: | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| load-with-esm.test.js              |     4 | N/A    | Node CJS/ESM loader specifics                                                                                                                                                     |
| context/assert.test.js             |     1 | OK     | test/koa-parity.test.ts + app.test.ts (ctx.assert)                                                                                                                                |
| context/cookies.test.js            |     5 | OK     | test/cookies.test.ts + security.test.ts (signing, keys, secure)                                                                                                                   |
| context/inspect.test.js            |     2 | N/A    | util.inspect output of Node res; ctx.toJSON covered                                                                                                                               |
| context/onerror.test.js            |    12 | OK     | test/official-parity.test.ts (header reset, statusCode, expose) + app.test.ts                                                                                                     |
| context/state.test.js              |     1 | OK     | test/app.test.ts + request.test.ts (ctx.state)                                                                                                                                    |
| context/throw.test.js              |    11 | OK     | test/errors.test.ts + official-parity.test.ts (msg/err/status/props/statusCode-ignore)                                                                                            |
| context/toJSON.test.js             |     1 | OK     | test/official-parity.test.ts (ctx.toJSON)                                                                                                                                         |
| response/append.test.js            |     4 | OK     | test/response.test.ts (append/vary/multi-value)                                                                                                                                   |
| response/attachment.test.js        |    25 | OK     | test/official-parity.test.ts (GHSA, basename, ?-mask, type:inline, fallback) + response.test.ts                                                                                   |
| response/back.test.js              |     8 | OK     | test/official-parity.test.ts (same-origin referrer, alt, root)                                                                                                                    |
| response/body.test.js              |    32 | OK     | test/response.test.ts + koa-parity.test.ts (string/buffer/stream/Blob/Response/JSON-null/object)                                                                                  |
| response/etag.test.js              |     4 | OK     | test/response.test.ts (quoting, weak, empty removal)                                                                                                                              |
| response/flushHeaders.test.js      |     6 | N/A    | Node res.flushHeaders(); fetch model flushes on return                                                                                                                            |
| response/get.test.js               |     4 | OK     | test/response.test.ts (get/array join/missing)                                                                                                                                    |
| response/has.test.js               |     2 | OK     | test/response.test.ts + coverage-gaps                                                                                                                                             |
| response/header.test.js            |     4 | OK     | test/response.test.ts (headers map)                                                                                                                                               |
| response/headers.test.js           |     2 | OK     | same as header                                                                                                                                                                    |
| response/inspect.test.js           |     2 | N/A    | Node res serialization; response.toJSON covered                                                                                                                                   |
| response/is.test.js                |     6 | OK     | test/official-parity.test.ts (shorthand/.ext/type+subtype wildcards)                                                                                                              |
| response/last-modified.test.js     |     4 | OK     | test/response.test.ts + coverage-gaps-2 (UTC round-trip, Date validation)                                                                                                         |
| response/length.test.js            |     5 | OK     | test/official-parity.test.ts + coverage-gaps-4 (undefined semantics, computed)                                                                                                    |
| response/message.test.js           |     3 | OK     | test/response.test.ts (default/override/CRLF guard)                                                                                                                               |
| response/redirect.test.js          |    10 | OK     | test/response.test.ts + koa-parity.test.ts (back/referrer/301/304/content-type reset)                                                                                             |
| response/remove.test.js            |     1 | OK     | test/response.test.ts (remove)                                                                                                                                                    |
| response/set.test.js               |     5 | OK     | test/official-parity.test.ts (object form) + response.test.ts                                                                                                                     |
| response/socket.test.js            |     1 | N/A    | Node socket                                                                                                                                                                       |
| response/status.test.js            |     9 | OK     | test/response.test.ts + official-parity.test.ts (204/205/304 strip, invalid codes); custom >599 & HTTP/2 N/A (fetch range 200-599)                                                |
| response/type.test.js              |     8 | OK     | test/official-parity.test.ts (shorthand expansion + charset)                                                                                                                      |
| response/vary.test.js              |     3 | OK     | test/response.test.ts (dedupe/token guard)                                                                                                                                        |
| response/writable.test.js          |     3 | N/A    | Node res writable state                                                                                                                                                           |
| lib/search-params.test.js          |     8 | OK     | test/koa-parity.test.ts (query setter stringify) + utils.test.ts (parse)                                                                                                          |
| request/accept.test.js             |     2 | N/A    | ctx.accept negotiator instance API; bun-koa exposes accepts()/accepts*() instead                                                                                                  |
| request/accepts.test.js            |     9 | OK     | test/request.test.ts + negotiation.test.ts + official-parity.test.ts (extensions)                                                                                                 |
| request/acceptsCharsets.test.js    |     5 | OK     | test/negotiation.test.ts + coverage-gaps-4                                                                                                                                        |
| request/acceptsEncodings.test.js   |     4 | OK     | test/negotiation.test.ts (identity RFC7231, q=0)                                                                                                                                  |
| request/acceptsLanguages.test.js   |     5 | OK     | test/negotiation.test.ts + coverage-gaps-2 (prefix both ways)                                                                                                                     |
| request/charset.test.js            |     4 | OK     | test/utils.test.ts (charsetFromContentType quotes/empty)                                                                                                                          |
| request/fresh.test.js              |     4 | OK     | test/request.test.ts + coverage-gaps-2/4 (etag/weak/*/If-Modified-Since/non-GET/304)                                                                                              |
| request/get.test.js                |     1 | OK     | test/request.test.ts (case-insensitive)                                                                                                                                           |
| request/header.test.js             |     2 | OK     | test/request.test.ts (Headers object semantics); header= setter N/A (immutable fetch headers)                                                                                     |
| request/headers.test.js            |     2 | OK     | same                                                                                                                                                                              |
| request/host.test.js               |    15 | OK     | test/request.test.ts + coverage-gaps-2 (authority fallback, x-forwarded-host, IPv6); HTTP/2 :authority N/A                                                                        |
| request/hostname.test.js           |    13 | OK     | test/utils.test.ts (IPv6/ports) + request.test.ts; HTTP/2 + @ userinfo branches N/A (fetch strips userinfo)                                                                       |
| request/href.test.js               |     2 | OK     | test/request.test.ts (origin+url, no-host fallback)                                                                                                                               |
| request/idempotent.test.js         |     2 | OK     | test/request.test.ts                                                                                                                                                              |
| request/inspect.test.js            |     2 | N/A    | Node req serialization; request.toJSON covered                                                                                                                                    |
| request/ip.test.js                 |     5 | OK     | test/request.test.ts (remote fallback via adapter, proxied first IP)                                                                                                              |
| request/ips.test.js                |     6 | OK     | test/request.test.ts (proxy off/on, maxIpsCount, custom proxyIpHeader)                                                                                                            |
| request/is.test.js                 |     7 | OK     | test/typeis.test.ts + request.test.ts (caller-form returns, urlencoded/multipart)                                                                                                 |
| request/length.test.js             |     8 | OK     | test/request.test.ts (missing/invalid/valid)                                                                                                                                      |
| request/origin.test.js             |     1 | OK     | test/request.test.ts                                                                                                                                                              |
| request/path.test.js               |     4 | OK     | test/request.test.ts + koa-parity.test.ts (path getter/setter via url)                                                                                                            |
| request/protocol.test.js           |     5 | OK     | test/request.test.ts + coverage-gaps-2 (xfp comma list, https URL)                                                                                                                |
| request/query.test.js              |     5 | OK     | test/utils.test.ts + koa-parity.test.ts (arrays, cache, object setter)                                                                                                            |
| request/querystring.test.js        |     6 | OK     | test/koa-parity.test.ts (querystring= setter) + request.test.ts                                                                                                                   |
| request/search.test.js             |     4 | OK     | test/koa-parity.test.ts (search= setter semantics)                                                                                                                                |
| request/secure.test.js             |     1 | OK     | test/request.test.ts (protocol-based)                                                                                                                                             |
| request/stale.test.js              |     1 | OK     | test/request.test.ts (stale = !fresh)                                                                                                                                             |
| request/subdomains.test.js         |     3 | OK     | test/request.test.ts + koa-parity.test.ts (offset live-change)                                                                                                                    |
| request/type.test.js               |     2 | OK     | test/request.test.ts (params stripped)                                                                                                                                            |
| request/whatwg-url.test.js         |     3 | OK     | test/official-parity.test.ts (req.URL / ctx.URL)                                                                                                                                  |
| application/compose.test.js        |     2 | N/A    | app.compose instance API; standalone compose() covered in test/compose.test.ts                                                                                                    |
| application/context.test.js        |     2 | OK     | test/official-parity.test.ts (app.context/request/response layers)                                                                                                                |
| application/currentContext.test.js |     9 | OK     | test/official-parity.test.ts (ALS on/opt-in/off); v8-snapshot case N/A                                                                                                            |
| application/index.test.js          |     8 | PART   | toJSON/use-chain/env/silent covered (app.test.ts); Node http listen/callback/inspect internals N/A                                                                                |
| application/inspect.test.js        |     2 | N/A    | util.inspect of Node internals                                                                                                                                                    |
| application/onerror.test.js        |     5 | OK     | test/app.test.ts (emit/silent/console guard) + official-parity                                                                                                                    |
| application/request.test.js        |     2 | OK     | test/official-parity.test.ts (app.request layer)                                                                                                                                  |
| application/respond.test.js        |    64 | OK     | test/response.test.ts + app.test.ts + smoke.ts (all body kinds, HEAD, missing body per status, errors, expose); ctx.respond=false / res-already-written / Node pipeline cases N/A |
| application/response.test.js       |     7 | OK     | test/official-parity.test.ts (app.response layer)                                                                                                                                 |
| application/toJSON.test.js         |     1 | OK     | test/app.test.ts                                                                                                                                                                  |
| application/use.test.js            |     4 | OK     | test/app.test.ts (chaining, validation, recompile)                                                                                                                                |
| index.js                           |     1 | OK     | module export shape (createRouter)                                                                                                                                                |
| lib/layer.js                       |    20 | OK     | test/trie.test.ts (compile: params, regex, optional, wildcard, errors)                                                                                                            |
| lib/router.js                      |   106 | OK     | test/router.test.ts (methods, params, param-mw, prefix, use/mount, redirect, allowedMethods 405/501, url(), nesting, HEAD fallback)                                               |

**Totals: 562 official cases — 528 fully verified, 8 partially (Node-only leftovers noted), 26 not applicable.**

### Deliberate divergences (documented, not bugs)

- **Param-position pattern sharing (trie node per position)**: the first
  registered custom pattern wins — a later plain `:id` stays constrained by
  an earlier `:id(\d+)` at the same position (@koa/router would match both).
- **Multiple controllers for multiple matching routes** (@koa/router runs every
  matching layer): bun-koa dispatches the single best match (static > param >
  wildcard). Multi-match chains would restructure the dispatch hot path.
- **`router.use()` timing (gh-182)**: bun-koa runs router middleware on every
  request that reaches the router; @koa/router gates it on route matches.
- **`strict` / `host` / `exclusive` router options**: accepted but inert.
- **fetch-run-time behaviors we cannot override**: string bodies always end up
  with `text/plain;charset=UTF-8` when Content-Type was cleared (`ctx.type =
null`), and `Content-Length` is dropped for stream bodies — the web
  `Response` layer owns both.
- **Cookie signature format**: single-cookie inline `value.sig`
  (HMAC-SHA256/base64url) instead of Keygrip's separate `name.sig` cookie —
  rotation semantics are equivalent, keys verify interchangeably.

### Not applicable, by design (fetch model / Bun)

- `res.flushHeaders()`, `res.socket`, `res.writable` — no Node response object exists.
- `ctx.respond = false`, 'res already written', Node stream pipeline cases — the framework returns a web `Response` atomically.
- `ctx.accept` / `ctx.accept=` (negotiator instance injection) — replaced by the `accepts*()` function family.
- `req.header = ` (replace whole header object) — fetch `Request` headers are immutable.
- HTTP/2 `:authority`, `httpVersionMajor` branches — Bun serves HTTP/1.1.
- Custom status codes outside 200-599 (e.g. 700) — the fetch `Response` range; Koa allows them only because Node does.
- `app.compose` instance API — the standalone `compose()` export covers the behavior.
- CJS/ESM loading, `util.inspect`, v8-snapshot tests — runtime-specific harness details.

### hono@4.13.5 cross-check

hono's suite (196 cases in `hono.test.ts` alone) tests hono's own API surface
(`c.html`, RPC clients, JSX, per-adapter helpers) which has no Koa-shaped equivalent.
The comparable semantics — routing capture, 404/405 behavior, middleware ordering,
header/status handling — are cross-checked in `test/router.test.ts`, `test/compose.test.ts`,
`scripts/smoke.ts`, and the equal-footing benchmarks in `bench/`.
