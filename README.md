# bun-koa

**Koa-compatible onion-model framework for [Bun 1.4+](https://bun.sh).** Same
middleware you know from Koa — `app.use`, `ctx.body`, `ctx.throw`, signed
cookies, content negotiation, `@koa/router`-style routing — rebuilt on
Bun's native `fetch` handler and **precompiled** middleware chains.

Zero runtime dependencies. **1.8x faster than Koa on Node**, at parity with
(or slightly ahead of) Hono while keeping the full Koa API.

```bash
bun add bun-koa
```

```ts
import { createApp, createRouter } from "bun-koa";

const app = createApp({ keys: ["signing-secret"] });

// Koa-style onion middleware
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  ctx.set("X-Response-Time", `${Date.now() - start}ms`);
});

const router = createRouter({ prefix: "/api" });

router.get("/users/:id(\\d+)", (ctx) => {
  ctx.body = { id: Number(ctx.params.id) };
});

app.use(router.routes()).use(router.allowedMethods());

export default app.listen(3000);
```

## Opt-in context pooling

```ts
const app = createApp({ pooling: true });
```

Recycles the three per-request context objects (~+5% throughput in
microbenchmarks). Only enable it when no middleware stores `ctx` beyond the
request lifetime (timers, background promises, external stores) — a recycled
context is rewritten by the next request. Default stays off; the zero-promise
sync fast path and all semantics are identical either way.

## Why it's fast

| Koa (Node)                                        | bun-koa (Bun)                                       |
| ------------------------------------------------- | --------------------------------------------------- |
| Recompiles dispatch closure **per request**       | Chain compiled **once** at `use()` time             |
| Every middleware hop wrapped in `Promise.resolve` | Fully-sync chains return with **zero promises**     |
| `req`/`res` objects + header re-serialization     | Web `Request`/`Response` passed through natively    |
| Eager body/URL work                               | Query, cookies, client IP, `ctx.state` are **lazy** |
| Router regex walk                                 | Static routes = one `Map` hash hit; params via trie |

Full numbers, methodology and a reproduction script: [bench/BENCH.md](bench/BENCH.md).

- **vs Koa 3 + @koa/router (Node 22): 1.8x** (text / JSON / params / middleware)
- **vs Hono 4 (Bun): 0.99–1.02x** over HTTP; framework overhead at parity or better,
  and the 3-middleware onion scenario edges ahead (precompiled chains vs
  per-request composition).

## API

### Application

| Member                           | Description                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `createApp(options?)`            | Factory (no classes anywhere). Options: `keys`, `proxy`, `proxyIpHeader`, `maxIpsCount`, `subdomainOffset`, `env`, `silent` |
| `app.use(...mw)`                 | Register middleware; chain recompiles automatically                                                                         |
| `app.handle(request, remote?)`   | Fetch-style handler `(Request) => Response \| Promise<Response>`                                                            |
| `app.listen(port?, host?, cb?)`  | Boots `Bun.serve`; returns the Bun `Server`                                                                                 |
| `app.on("error", fn)`            | Central error hook; `silent`/`env: "test"` suppress default logging                                                         |
| `app.callback()`, `app.toJSON()` | Koa-compatible helpers                                                                                                      |

### Context

Everything Koa's context delegates, with the same semantics:

- Request: `method url path query querystring search host hostname protocol
secure ip ips subdomains origin href fresh stale idempotent charset length
type header headers get is accepts acceptsEncodings acceptsCharsets
acceptsLanguages originalUrl` (`url` is settable for re-routing)
- Response: `status message body type length etag lastModified attachment
redirect set append remove vary headerSent responseHeaders`
- `ctx.state`, `ctx.cookies`, `ctx.throw(status, msg?, props?)`,
  `ctx.assert(cond, status, ...)`, `ctx.params` (set by the router)

### Cookies

`ctx.cookies.get(name, { signed })` / `ctx.cookies.set(name, value, options)`
with `maxAge expires path domain secure httpOnly sameSite partitioned priority
overwrite signed`. Signing is HMAC-SHA256 with key rotation (Keygrip format:
`value.signature`).

### Router

`createRouter({ prefix })` with the `@koa/router` surface: `get post put patch
delete head options all register use prefix param redirect route url routes
allowedMethods`. Patterns: `:name`, `:name(\\d+)` (custom regex), `:name?`
(optional), `*` (wildcard tail). HEAD falls back to GET handlers
(Express-style). `allowedMethods()` answers 405 + `Allow` (501 for unknown
verbs). Nested routers: `parent.use("/mount", child.routes())` mounts with
koa-mount semantics.

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
