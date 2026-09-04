/**
 * Agent security review — R4.3 single-slot error mapper funnel (commit 6ac9706).
 * Contract source: docs/HOTPATH-R4-3-MIGRATION-ERROR-POLICY.md §2.2–2.3.
 *
 * Every test asserts the SECURE behavior the docs/contract promises. Tests
 * marked with a FINDING comment were RED against 6ac9706 at review time.
 */

import { describe, expect, it, vi } from "vitest";
import { connect } from "node:net";

import { Keala } from "../src/core/app.ts";
import { startNodeServer } from "../src/adapters/node.ts";

const requestFor = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost:3000${path}`, init);

const boot = (setup?: (app: Keala) => void): Keala => {
  const app = new Keala({ env: "test" });
  if (setup !== undefined) setup(app);
  return app;
};

describe("agent security review: error.headers content framing", () => {
  // FINDING F1 (P1, wire-exploitable via the Node adapter) — mergeAbsentHeaders
  // (src/core/dispatch.ts) filters content-describing headers only out of the
  // STAGED record; error.headers are merged unfiltered, contradicting rule 3
  // ("content-describing headers are never backfilled") and the function's own
  // docstring ("Content-describing headers are never merged").
  it("F1: error.headers never merge content-length onto a takeover Response whose body differs", async () => {
    const app = boot((a) => {
      a.get("/cl", (c) => c.throw(502, "upstream", { headers: { "content-length": "5" } }));
      a.onError(() => new Response("this takeover body is much longer than five bytes"));
    });
    const res = await app.handle(requestFor("/cl"));
    const body = await res.clone().text();
    // A declared 5 with a 49-byte body is a framing lie; the merge must not do it.
    expect(res.headers.get("content-length")).toBeNull();
    expect(body.length).toBeGreaterThan(5);
  });

  it("F1: error.headers never merge transfer-encoding onto a takeover Response", async () => {
    const app = boot((a) => {
      a.get("/te", (c) =>
        c.throw(502, "upstream", { headers: { "transfer-encoding": "chunked" } }),
      );
      a.onError(() => new Response("a takeover body"));
    });
    const res = await app.handle(requestFor("/te"));
    expect(res.headers.get("transfer-encoding")).toBeNull();
  });

  it("F1: error.headers never merge content-type onto a bodiless-type takeover Response", async () => {
    const app = boot((a) => {
      a.get("/ct", (c) => c.throw(502, "upstream", { headers: { "content-type": "text/html" } }));
      // A stream body carries no implicit content-type on either runtime,
      // making the if-absent slot observably empty before the merge.
      a.onError(
        () =>
          new Response(
            new ReadableStream({
              start(ctrl) {
                ctrl.enqueue(new TextEncoder().encode("stream"));
                ctrl.close();
              },
            }),
          ),
      );
    });
    const res = await app.handle(requestFor("/ct"));
    expect(res.headers.get("content-type")).not.toBe("text/html");
  });

  // FINDING F1 (wire evidence): the Node adapter writes response headers
  // verbatim (adapters/node.ts writeResponse -> out.setHeader), so the merged
  // content-length reaches node:http as-is. Node trusts it for framing: the
  // declared 5-byte body is followed by 39 more bytes that a keep-alive client
  // or proxy parses as the NEXT response on the connection (response
  // smuggling/desync, confirmed with a raw socket under real node). Bun.serve
  // recomputes string/stream body lengths, masking the defect on the Bun wire
  // — the Response object still carries the lie for any fetch-based gateway.
  it.skipIf(typeof Bun !== "undefined")(
    "F1-wire: takeover framing on the Node adapter stays consistent (no smuggled bytes past declared content-length)",
    { timeout: 15_000 },
    async () => {
      const app = new Keala({ env: "test" });
      app.get("/evil", (c) => c.throw(502, "upstream", { headers: { "content-length": "5" } }));
      app.get("/ok", (c) => {
        c.body = "OK-BODY";
      });
      app.onError(() => new Response("SMUGGLED-CONTENT-FOLLOWS-HERE-IN-BYTES"));
      const handle = startNodeServer(app, { port: 0 });
      const server = await handle.ready();
      try {
        const wire: string = await new Promise((resolve, reject) => {
          const sock = connect(server.port, "127.0.0.1");
          let buf = "";
          const finish = () => {
            sock.destroy();
            resolve(buf);
          };
          sock.on("connect", () =>
            // Two pipelined requests on one keep-alive connection.
            sock.write(
              "GET /evil HTTP/1.1\r\nHost: x\r\n\r\nGET /ok HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
            ),
          );
          sock.on("data", (d: Buffer) => {
            buf += d.toString("latin1");
          });
          sock.on("end", finish);
          sock.on("error", reject);
          setTimeout(finish, 8000);
        });
        // Parse only the FIRST response header block. The second pipelined
        // direct response legitimately carries its own Content-Length; a
        // whole-wire regexp would attribute that value to the first streamed
        // response and manufacture a framing failure.
        const firstHeaderEnd = wire.indexOf("\r\n\r\n");
        const firstHeaders = wire.slice(0, firstHeaderEnd);
        const declared = Number(/^content-length: (\d+)\r?$/im.exec(firstHeaders)?.[1] ?? "-1");
        // FIXED WORLD: the forged content-length from error.headers never
        // reaches the wire (pre-fix: declared === 5 over a 39-byte body).
        expect(declared).not.toBe(5);
        const bodyStart = firstHeaderEnd + 4;
        const nextResponse = wire.indexOf("HTTP/1.1", bodyStart);
        const firstBodyBytes = wire.slice(
          bodyStart,
          nextResponse === -1 ? undefined : nextResponse,
        );
        // SECURE: the bytes before the next response exactly match the declared
        // length. OBSERVED: 39 smuggled bytes ("SMUGGLED-CONTENT...") precede
        // the second response — every keep-alive client desyncs.
        // Framing consistency: when the adapter declares a length it must
        // match the actual body bytes (no smuggled remainder).
        if (declared !== -1) {
          expect(firstBodyBytes.length).toBe(declared);
        }
      } finally {
        server.stop();
      }
    },
  );
});

describe("agent security review: merge abort stripping staged security headers", () => {
  // FINDING F2 (P1) — mergeAbsentHeaders wraps the WHOLE merge in one
  // try/catch (dispatch.ts). One invalid entry in error.headers (CRLF value,
  // invalid field name) makes Headers.set throw, the catch aborts everything
  // AFTER it — including all staged security headers (CSP/HSTS staged via
  // c.set before the throw). The builtin path drops only the offending header
  // (per-header try/catch); the takeover path must not strip the rest.
  // Contract: buildErrorResponse's own comment — "security headers must still
  // cover error pages".
  it("F2: an invalid error.header VALUE (CRLF) drops only that header, keeping staged security headers on the takeover", async () => {
    const app = boot((a) => {
      a.use((c, next) => {
        void c.setHeader("x-security", "on");
        return next();
      });
      a.get("/bad", (c) =>
        c.throw(500, "x", {
          headers: { "www-authenticate": "Bearer", "x-evil": "a\r\nInjected: yes" },
        }),
      );
      a.onError(() => new Response("takeover"));
    });
    const res = await app.handle(requestFor("/bad"));
    // The valid error header merged BEFORE the bad entry survives today…
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    // …but the staged security header is silently stripped (OBSERVED null).
    expect(res.headers.get("x-security")).toBe("on");
  });

  it("F2: an invalid error.header NAME drops only that header, keeping staged security headers on the takeover", async () => {
    const app = boot((a) => {
      a.use((c, next) => {
        void c.setHeader("x-security", "on");
        return next();
      });
      a.get("/bad2", (c) => c.throw(500, "x", { headers: { "x-fine": "kept", "bad name": "v" } }));
      a.onError(() => new Response("takeover"));
    });
    const res = await app.handle(requestFor("/bad2"));
    expect(res.headers.get("x-fine")).toBe("kept");
    expect(res.headers.get("x-security")).toBe("on");
  });

  // Contrast lock (PASSES): neither path ever lets the CRLF VALUE itself
  // reach a response — Headers.set rejects CR/LF/NUL on both runtimes, so the
  // classic header-injection payload dies at the boundary.
  it("secure-contrast: a CRLF error.header value never reaches the takeover response", async () => {
    const app = boot((a) => {
      a.get("/inject", (c) => c.throw(500, "x", { headers: { "x-evil": "a\r\nInjected: yes" } }));
      a.onError(() => new Response("takeover"));
    });
    const res = await app.handle(requestFor("/inject"));
    expect(res.headers.get("x-evil")).toBeNull();
    expect(res.headers.get("Injected")).toBeNull();
    const flat = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(flat).not.toContain("Injected");
  });
});

describe("agent security review: funnel coverage of frozen errors", () => {
  // FINDING F3 (P1) — toHttpError (src/http/errors.ts) classifies non-HttpError
  // throwables IN PLACE (status=500/expose=false writes). A frozen or otherwise
  // non-writable Error makes that assignment throw in strict mode, the funnel
  // dies before the mapper branch, and errorResponse's catch answers the static
  // 500. Rules 2 ("the mapper ALWAYS receives an HttpError") and 6 (observation)
  // are both bypassed; shared frozen error constants are a legitimate pattern.
  it("F3: a frozen Error still reaches the mapper as an unexposed 500 HttpError", async () => {
    const frozen = Object.freeze(new Error("shared constant error"));
    let seen = 0;
    const app = boot((a) => {
      a.get("/frz", () => {
        throw frozen;
      });
      a.onError((error) => {
        seen += 1;
        return new Response(`mapped:${error.status}:${error.expose}`, { status: error.status });
      });
    });
    const res = await app.handle(requestFor("/frz"));
    expect(seen).toBe(1); // OBSERVED 0 before the fix — the mapper never ran
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("mapped:500:false");
  });

  it("F3: a frozen error-like (non-writable, [object Error] tag) is normalized, not fatal to the funnel", async () => {
    const fake = Object.assign(Object.create(Error.prototype), { message: "fake" });
    Object.freeze(fake);
    let seen = 0;
    const app = boot((a) => {
      a.get("/frz3", () => {
        throw fake;
      });
      a.onError((error) => {
        seen += 1;
        return new Response("mapped", { status: error.status });
      });
    });
    const res = await app.handle(requestFor("/frz3"));
    expect(seen).toBe(1);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("mapped");
  });
});

describe("agent security review: Set-Cookie and multi-value fidelity on error pages", () => {
  // FINDING F4 (P2) — mergeAbsentHeaders joins array values in error.headers
  // with ", " (dispatch.ts). Set-Cookie joined into ONE header line is not
  // parseable per RFC 6265: the second cookie is lost or its attributes
  // misparse, and comma-splitting intermediaries have historically treated it
  // as two headers. The builtin path keeps distinct lines; the takeover path
  // must match.
  it("F4: error.headers set-cookie arrays stay separate Set-Cookie lines on a takeover", async () => {
    const app = boot((a) => {
      a.get("/ck", (c) =>
        c.throw(401, "no", {
          expose: true,
          headers: { "set-cookie": ["a=1; Path=/", "b=2; Path=/admin"] },
        }),
      );
      a.onError(() => new Response("no", { status: 401 }));
    });
    const res = await app.handle(requestFor("/ck"));
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/admin"]);
  });

  // FINDING F4b (P2) — the staged loop has the mirror bug: flattenHeaders
  // emits one pair per array item but the `!headers.has(name)` guard lets only
  // the FIRST item land, so cookies staged before a throw (session rotation,
  // CSRF tokens, clearing cookies) silently vanish from takeover error pages.
  it("F4b: cookies staged before the throw all survive on a takeover error page", async () => {
    const app = boot((a) => {
      a.use((c, next) => {
        c.cookies.set("sess", "abc", { path: "/" });
        c.cookies.set("csrf", "tok", { path: "/" });
        return next();
      });
      a.get("/x", () => {
        throw new Error("boom");
      });
      a.onError(() => new Response("takeover"));
    });
    const res = await app.handle(requestFor("/x"));
    expect(res.headers.getSetCookie()).toEqual(["sess=abc; Path=/", "csrf=tok; Path=/"]);
  });

  it("F4b: staged multi-value headers keep every value on a takeover", async () => {
    const app = boot((a) => {
      a.use((c, next) => {
        void c.setHeader("www-authenticate", ["Basic", "Bearer"]);
        return next();
      });
      a.get("/x", () => {
        throw new Error("boom");
      });
      a.onError(() => new Response("takeover"));
    });
    const res = await app.handle(requestFor("/x"));
    expect(res.headers.get("www-authenticate")).toBe("Basic, Bearer");
  });

  // Contrast lock (PASSES): the builtin decline path keeps error.headers
  // set-cookie arrays as separate lines (the same-name overwrite of staged
  // cookies is intended "latest intent wins" semantics, like retry-after).
  it("secure-contrast: the builtin error path keeps separate Set-Cookie lines", async () => {
    const app = boot((a) => {
      a.get("/ck", (c) =>
        c.throw(401, "no", {
          expose: true,
          headers: { "set-cookie": ["a=1; Path=/", "b=2; Path=/admin"] },
        }),
      );
    });
    const res = await app.handle(requestFor("/ck"));
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/admin"]);
  });
});

describe("agent security review: header-name policy divergence", () => {
  // FINDING F5 (P2) — the builtin path validates through c.set, which rejects
  // FORBIDDEN_NAMES ("__proto__", "constructor", "prototype" — utils/text.ts
  // "Names that must never become header fields"). mergeAbsentHeaders calls
  // Headers.set directly, which happily accepts them: the two error paths
  // enforce different header-name policies.
  it("F5: the takeover merge honors the forbidden-header-name policy", async () => {
    const hdrs: Record<string, string> = {};
    Object.defineProperty(hdrs, "__proto__", { value: "should-not-set", enumerable: true });
    const app = boot((a) => {
      a.get("/x", (c) => c.throw(500, "x", { headers: hdrs as never }));
      a.onError(() => new Response("takeover"));
    });
    const res = await app.handle(requestFor("/x"));
    expect(res.headers.get("__proto__")).toBeNull(); // OBSERVED "should-not-set"
  });

  // Contrast lock (PASSES): the builtin path drops it.
  it("secure-contrast: the builtin path drops forbidden header names from error.headers", async () => {
    const hdrs: Record<string, string> = {};
    Object.defineProperty(hdrs, "__proto__", { value: "should-not-set", enumerable: true });
    const app = boot((a) => {
      a.get("/x", (c) => c.throw(500, "x", { headers: hdrs as never }));
    });
    const res = await app.handle(requestFor("/x"));
    expect(res.headers.get("__proto__")).toBeNull();
  });
});

describe("agent security review: information disclosure sweep (contract holds)", () => {
  // These lock the SECURE behaviors that were audited and found intact:
  // non-exposed messages never reach any response body, in any mode.
  it("non-exposed unexpected errors never leak message in GET, HEAD, decline, or static-500 paths", async () => {
    const secret = "secret internals: db password hunter2";
    const routes = (a: Keala): void => {
      a.get("/t", () => {
        throw new TypeError(secret);
      });
      a.get("/s", () => {
        throw "boom string";
      });
    };

    const cases = ["/t", "/s"] as const;
    for (const mode of ["unregistered", "decline", "failing-mapper"] as const) {
      const app = boot((a) => {
        routes(a);
        if (mode === "decline") a.onError(() => undefined);
        else if (mode === "failing-mapper")
          a.onError(() => {
            throw new Error("mapper bug");
          });
      });
      for (const path of cases) {
        const res = await app.handle(requestFor(path));
        const body = await res.text();
        expect(res.status).toBe(500);
        expect(body).not.toContain(secret);
        expect(body).not.toContain("boom string");
        expect(body).toBe("Internal Server Error");
      }
    }
  });

  it("HEAD error responses carry no body and leak nothing in headers", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = boot((a) => {
        a.get("/t", () => {
          throw new TypeError("secret internals");
        });
      });
      const res = await app.handle(requestFor("/t", { method: "HEAD" }));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("");
      const flat = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
      expect(flat).not.toContain("secret");
    } finally {
      consoleError.mockRestore();
    }
  });
});
