/**
 * r6 differential audit — honu vs the REAL koa 3.2.1 stack.
 *
 * koa 3.2.1 (+ @koa/router 15.7) is driven through `app.callback()` with
 * minimal hand-written node:http mocks; honu through `app.handle(Request)`.
 * Observable responses (status / headers / body) are compared field by field,
 * and shared semantics are unit-diffed against the real packages koa links.
 * RED `it`s assert honu equals the live-computed koa reference (the comment
 * states the koa value); the last describe locks INTENTIONAL divergences.
 */

import { describe, expect, it } from "vitest";

import Koa from "koa";
import { Router } from "@koa/router";
import contentDispositionPkg from "content-disposition";
import acceptsPkg from "accepts";

import { createApp } from "../src/index.ts";
import { typeIs } from "../src/negotiation/typeis.ts";
import { contentDisposition } from "../src/utils/text.ts";
import { acceptsType, acceptsEncoding } from "../src/negotiation/accepts.ts";
import typeisPkg from "type-is";

// --- Harness: minimal node mocks for koa's (req, res) callback contract. ---

class MockRes {
  statusCode = 404;
  statusMessage: string | undefined;
  headersSent = false;
  finished = false;
  writableEnded = false;
  chunks: unknown[] = [];
  private headerMap: Record<string, unknown> = Object.create(null);
  private handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  setHeader(k: string, v: unknown) {
    this.headerMap[k.toLowerCase()] = v;
    return this;
  }
  getHeader(k: string) {
    return this.headerMap[k.toLowerCase()];
  }
  hasHeader(k: string) {
    return this.headerMap[k.toLowerCase()] !== undefined;
  }
  removeHeader(k: string) {
    delete this.headerMap[k.toLowerCase()];
  }
  getHeaderNames() {
    return Object.keys(this.headerMap);
  }
  getHeaders() {
    return this.headerMap;
  }
  write(chunk: unknown) {
    this.chunks.push(chunk);
    return true;
  }
  end(chunk?: unknown) {
    if (chunk !== undefined) this.chunks.push(chunk);
    this.headersSent = true;
    this.finished = true;
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }
  on(ev: string, fn: (...a: unknown[]) => void) {
    (this.handlers[ev] ??= []).push(fn);
    return this;
  }
  once(ev: string, fn: (...a: unknown[]) => void) {
    return this.on(ev, fn);
  }
  removeListener(ev: string, fn: (...a: unknown[]) => void) {
    const list = this.handlers[ev];
    if (list) this.handlers[ev] = list.filter((f) => f !== fn);
    return this;
  }
  emit(ev: string, ...args: unknown[]) {
    const list = this.handlers[ev];
    if (list) for (const fn of list.slice()) fn(...args);
    return true;
  }
}

interface Snapshot {
  status: number;
  headers: Record<string, unknown>;
  body: string;
}

type ReqInit = { url?: string; method?: string; headers?: Record<string, string> };

const driveKoa = async (
  setup: (app: InstanceType<typeof Koa>) => void,
  reqInit: ReqInit,
): Promise<Snapshot> => {
  const app = new Koa({ env: "test" });
  app.silent = true;
  setup(app);
  const headers: Record<string, string> = { host: "localhost:3000" };
  for (const [k, v] of Object.entries(reqInit.headers ?? {})) headers[k.toLowerCase()] = v;
  const req = {
    url: reqInit.url ?? "/",
    method: reqInit.method ?? "GET",
    headers,
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    socket: undefined,
    on() {},
    once() {},
    emit() {
      return true;
    },
  };
  const res = new MockRes();
  await (app.callback() as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return {
    status: res.statusCode,
    headers: { ...res.getHeaders() } as Record<string, unknown>,
    body: res.chunks.map(String).join(""),
  };
};

const driveBun = async (
  setup: (app: ReturnType<typeof createApp>) => void,
  reqInit: ReqInit,
): Promise<Snapshot> => {
  const app = createApp({ env: "test" } as const);
  setup(app);
  const res = await app.handle(
    new Request(`http://localhost:3000${reqInit.url ?? "/"}`, {
      method: reqInit.method ?? "GET",
      headers: reqInit.headers,
    }),
  );
  const headers: Record<string, unknown> = {};
  for (const k of res.headers.keys()) headers[k] = res.headers.get(k);
  return { status: res.status, headers, body: await res.text() };
};

/** koa-reference shortcuts for the accepts dimensions. */
const koaEncodings = (header: string, provided: string[]) =>
  acceptsPkg({ headers: { "accept-encoding": header } } as never).encodings(...provided) ?? null;
const koaTypes = (header: string, provided: string[]) =>
  acceptsPkg({ headers: { accept: header } } as never).type(...provided) ?? null;

// --- CONFIRMED BUGS (red): honu deviates from koa without justification. ---

describe("r6 diff — type-is: `*/*` never matches", () => {
  it("`ctx.is(['*/*'])` returns false instead of the incoming type", () => {
    // koa (type-is): typeis(req, ['*/*']) with Content-Type: application/json
    //   => 'application/json' — the canonical match-anything pattern.
    // honu: lowers '*/*' into the `endsWith('/*')` branch with prefix '*/'
    //   (no normalized type starts with it) => false.
    const req = { headers: { "content-type": "application/json", "content-length": "10" } };
    expect(typeIs("application/json", ["*/*"])).toBe(typeisPkg(req as never, ["*/*"])); // koa: 'application/json'
  });

  it("`*/*` fails at the ctx level for every content type", async () => {
    // koa reference: ctx.is(['*/*']) === ctx.reqType for any body-bearing
    // request ('multipart/form-data', 'text/html', ...).
    const koaRef = await driveKoa(
      (app) => {
        app.use((ctx) => {
          ctx.body = String(ctx.is(["*/*"]));
        });
      },
      {
        url: "/",
        method: "POST",
        headers: { "content-type": "multipart/form-data", "content-length": "10" },
      },
    );
    const bun = await driveBun(
      (app) => {
        app.use((c) => {
          c.body = String(c.is(["*/*"]));
        });
      },
      {
        url: "/",
        method: "POST",
        headers: { "content-type": "multipart/form-data", "content-length": "10" },
      },
    );
    expect(bun.body).toBe(koaRef.body); // koa: 'multipart/form-data', bun: 'false'
  });
});
describe("r6 diff — redirect Location (encodeurl)", () => {
  const loc = async (target: string) => ({
    koa: (await driveKoa((app) => app.use((ctx) => ctx.redirect(target)), { url: "/" })).headers[
      "location"
    ],
    bun: (await driveBun((app) => app.use((c) => c.redirect(target)), { url: "/" })).headers[
      "location"
    ],
  });

  it("an invalid percent escape is left raw instead of being %25-escaped", async () => {
    // koa (encodeurl): '/trailing%' => '/trailing%25' — a '%' not followed by
    // two hex digits is NOT a valid escape and gets encoded.
    // honu: keeps the bare '%', shipping a malformed Location value.
    const { koa, bun } = await loc("/trailing%");
    expect(bun).toBe(koa); // koa: '/trailing%25'
  });

  it("a '%zz'-style invalid escape is left raw", async () => {
    const { koa, bun } = await loc("/%zz invalid");
    expect(bun).toBe(koa); // koa: '/%25zz%20invalid'
  });

  it("a lone apostrophe is percent-encoded ('%27') where koa keeps it", async () => {
    const { koa, bun } = await loc("/a'apos");
    expect(bun).toBe(koa); // koa: "/a'apos"
  });

  it("'{' and '}' are not encoded where koa emits %7B/%7D", async () => {
    const { koa, bun } = await loc("/{brace}");
    expect(bun).toBe(koa); // koa: '/%7Bbrace%7D'
  });
});
describe("r6 diff — content-disposition", () => {
  it("latin-1 filenames are masked to '?' and gain a spurious filename*", () => {
    // koa (content-disposition): TEXT_REGEXP allows \x80-\xff in the quoted
    //   form, so 'naïve file.txt' => 'attachment; filename="naïve file.txt"'
    //   with NO filename* (the latin-1 fallback equals the name).
    // honu: isAscii is /^[\x20-\x7e]*$/ (ASCII only) => masks 'ï' to '?'
    //   and appends filename*=UTF-8''na%C3%AFve%20file.txt.
    expect(contentDisposition("naïve file.txt")).toBe(contentDispositionPkg("naïve file.txt"));
  });

  it("latin-1 divergence is observable on ctx.attachment", async () => {
    const koa = await driveKoa((app) => app.use((ctx) => ctx.attachment("résumé.pdf")), {
      url: "/",
    });
    const bun = await driveBun((app) => app.use((c) => c.attachment("résumé.pdf")), { url: "/" });
    expect(bun.headers["content-disposition"]).toBe(koa.headers["content-disposition"]);
    // koa: 'attachment; filename="résumé.pdf"'
    // bun: 'attachment; filename="r?sum?.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf'
  });

  it("an ASCII filename containing a %XX escape lacks the filename* parameter", () => {
    // koa (content-disposition): HEX_ESCAPE_REGEXP forces BOTH parameters so
    //   legacy clients cannot URL-decode the quoted name:
    //   '50%20off.txt' => 'attachment; filename="50%20off.txt"; filename*=UTF-8''50%2520off.txt'
    // honu: early-returns the plain filename only.
    expect(contentDisposition("50%20off.txt")).toBe(contentDispositionPkg("50%20off.txt"));
  });

  it("a string fallback is ignored when the filename is ASCII", () => {
    // koa (content-disposition): an explicit fallback string ALWAYS becomes
    //   the legacy name and forces filename* (fallbackName !== name):
    //   ('file.txt', 'fallback.txt') => 'attachment; filename="fallback.txt"; filename*=UTF-8''file.txt'
    // honu: only applies the fallback when the filename is non-ASCII.
    expect(contentDisposition("file.txt", "fallback.txt")).toBe(
      contentDispositionPkg("file.txt", { fallback: "fallback.txt" }),
    );
  });
});
describe("r6 diff — attachment Content-Type inference", () => {
  it("'.bin' fails to infer application/octet-stream", async () => {
    // koa: ctx.attachment('data.bin') => Content-Type 'application/octet-stream'
    //   (mime-types lookup of '.bin'). honu: EXT_TO_MIME has no 'bin' entry
    //   (TYPE_MAP does!) so no Content-Type is set and the runtime default
    //   'text/plain' leaks into a binary download.
    const koa = await driveKoa(
      (app) =>
        app.use((ctx) => {
          ctx.attachment("data.bin");
          ctx.body = "x";
        }),
      { url: "/" },
    );
    const bun = await driveBun(
      (app) =>
        app.use((c) => {
          c.attachment("data.bin");
          c.body = "x";
        }),
      { url: "/" },
    );
    expect(bun.headers["content-type"]).toBe(koa.headers["content-type"]); // koa: 'application/octet-stream'
  });
});
describe("r6 diff — response type expansion charset", () => {
  it("c.type = '.html' drops the charset that koa's expansion adds", async () => {
    // koa: response.type = '.html' goes through mime-types contentType =>
    //   'text/html; charset=utf-8' (identical to type = 'html').
    // honu: the extension path returns the bare EXT_TO_MIME value
    //   ('text/html') — inconsistent with its own shorthand path.
    const koa = await driveKoa(
      (app) =>
        app.use((ctx) => {
          ctx.type = ".html";
          ctx.body = "x";
        }),
      { url: "/" },
    );
    const bun = await driveBun(
      (app) =>
        app.use((c) => {
          c.type = ".html";
          c.body = "x";
        }),
      { url: "/" },
    );
    expect(bun.headers["content-type"]).toBe(koa.headers["content-type"]); // koa: 'text/html; charset=utf-8'
  });
});
describe("r6 diff — router vs @koa/router 15.7", () => {
  const koaApp = (routes: (r: Router) => void) => (app: InstanceType<typeof Koa>) => {
    const router = new Router();
    routes(router);
    app.use(router.routes());
    app.use(router.allowedMethods());
  };

  it("synthesized 405/501 responses carry the koa status-message body", async () => {
    // koa: allowedMethods() sets only status+Allow; koa's respond() fills the
    // null body with ctx.message => '<message>'.
    const koa = await driveKoa(
      koaApp((r) =>
        r.get("/thing", (ctx) => {
          ctx.body = "g";
        }),
      ),
      { url: "/thing", method: "DELETE" },
    );
    const bun = await driveBun((app) => app.get("/thing", (c) => c.text("g")), {
      url: "/thing",
      method: "DELETE",
    });
    expect(bun.status).toBe(koa.status); // both 405
    expect(bun.body).toBe(koa.body); // koa: 'Method Not Allowed'
    const koa501 = await driveKoa(
      koaApp((r) =>
        r.get("/thing", (ctx) => {
          ctx.body = "g";
        }),
      ),
      { url: "/thing", method: "MKCOL" },
    );
    const bun501 = await driveBun((app) => app.get("/thing", (c) => c.text("g")), {
      url: "/thing",
      method: "MKCOL",
    });
    expect(bun501.status).toBe(koa501.status); // both 501
    expect(bun501.body).toBe(koa501.body); // koa: 'Not Implemented'
  });
});
describe("r6 diff — accepts negotiation", () => {
  it("an exact q=0 refusal is bypassed by a wildcard", () => {
    // koa (negotiator): a provided type's quality is defined by its MOST
    //   SPECIFIC matching range — 'text/html;q=0' refuses html outright, so
    //   .type('html') is false even though '*/*' would accept it.
    // honu: pickPreference filters q=0 ranges BEFORE the specificity match.
    expect(acceptsType("text/html;q=0, */*", ["html"]) ?? null).toBe(
      koaTypes("text/html;q=0, */*", ["html"]),
    ); // koa: false, bun: 'html'
  });

  it("an exact q=0 refusal is bypassed even when the wildcard sorts first", () => {
    const header = "*/*;q=1, text/html;q=1, application/json;q=0";
    expect(acceptsType(header, ["application/json"]) ?? null).toBe(
      koaTypes(header, ["application/json"]),
    ); // koa: false, bun: 'application/json'
  });

  it("duplicate same-specificity ranges keep the FIRST q instead of the highest", () => {
    // koa (negotiator): among equally-specific ranges for one value the
    // HIGHER q defines the quality ('gzip;q=0.001, gzip;q=0.3' => 0.3), so
    // gzip ties identity at 0.3 and wins on header order. honu's
    // `s > matchScore` keeps the first exact range (q=0.001).
    const header = "gzip;q=0.001, gzip;q=0.3, identity;q=0.3";
    expect(acceptsEncoding(header, ["gzip", "identity"]) ?? null).toBe(
      koaEncodings(header, ["gzip", "identity"]),
    ); // koa: 'gzip', bun: 'identity'
  });

  it("duplicate wildcard ranges keep the FIRST q instead of the highest", () => {
    const header = "*/*;q=0.001, application/json;q=0.001, */*;q=1";
    expect(acceptsType(header, ["html", "json"]) ?? null).toBe(koaTypes(header, ["html", "json"])); // koa: 'html', bun: 'json'
  });
});
