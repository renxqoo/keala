/**
 * ROUND 6 property audit — split of the original agent-r6-prop
 * file (500-line budget). Rig: agent-r6-prop-rig.ts / -ops.ts.
 */

import { describe, expect, it } from "vitest";
import { quiet } from "./agent-r6-prop-rig.mts";
import { Keala } from "../src/index.ts";

describe("agent-r6 RED: confirmed violations", () => {
  it("R6-1 [INV-8, seed head-dirty-committed#17] non-latin-1 header value must not flood app.onerror", async () => {
    // Minimal repro of the property failure at seed 17 (ops [set,type,message,
    // body]): a header VALUE that passes c.setHeader() validation (only CR/LF/NUL
    // are rejected by validateHeaderValue, src/utils/text.ts:63) but is not a
    // ByteString (code unit > 0xFF) throws in the fetch Headers constructor
    // at finalize. buildErrorResponse (src/core/dispatch.ts:261-266) keeps the
    // offending staged header in c.headersRecord (only content-* headers are
    // dropped), so the rebuilt error response throws AGAIN, re-entering
    // errorResponse -> buildErrorResponse -> finalizeGuarded in an unbounded
    // mutual recursion that only stops at stack overflow (~1.3k frames), each
    // level firing app.onerror once. In production (env != test, no listener)
    // every level also console.error's the full stack — a log-flood amplifier
    // reachable with a single request. Correct contract: onerror fires once.
    const app = new Keala({ ...quiet });
    let onerror = 0;
    app.onError(() => {
      onerror++;
    });
    app.get("/r", (c) => {
      c.setHeader("x-unicode", "café中"); // 0xE9 and 0x4E2D — not a ByteString
      c.body = "ok";
      return undefined;
    });
    const res = await app.handle(new Request("http://localhost/r"));
    expect(res.status).toBe(500);
    expect(onerror).toBe(1); // RED: fires ~1354x today
  }, 10_000);

  it("R6-2 [INV-7, seed head-dirty-committed#148] a HEAD response must never carry a body", async () => {
    // The last-resort staticServerError() (src/core/dispatch.ts:240-244) is
    // `new Response("Internal Server Error", …)` — it ignores the request
    // method, so a HEAD request whose finalize failed answers with a BODIED
    // 500. RFC 9110 §9.3.2: a server MAY send headers for HEAD as if GET,
    // but MUST NOT send a body — a bodied HEAD desyncs any keep-alive
    // connection (the client reads the body bytes as the next response).
    const app = new Keala({ ...quiet });
    app.get("/r", (c) => {
      c.setHeader("x-unicode", "café中");
      c.body = "ok";
      return undefined;
    });
    const res = await app.handle(new Request("http://localhost/r", { method: "HEAD" }));
    expect(res.status).toBe(500);
    expect(res.body).toBe(null); // RED: "Internal Server Error" today
  }, 10_000);

  it("R6-3 [INV-7+INV-8, seed head-dirty-committed#17/35/140/148] post-commit mutation with a non-latin-1 value", async () => {
    // The exact fuzz shape from the property: a committed json response whose
    // outer middleware stages a unicode header (plus benign type/message/body
    // writes) after next(). rebuildCommitted's headers.set() throws, the
    // error path re-stages the poison header, and the recursion above runs —
    // onerror floods and the HEAD answer is bodied.
    const app = new Keala({ ...quiet });
    let onerror = 0;
    app.onError(() => {
      onerror++;
    });
    app.use(async (c, next) => {
      await next();
      c.setHeader("x-unicode", "café中"); // the poison write (seed 17's `set` op)
      c.type = "bogus"; // seed 17's `type` op (in-place post-commit in 0.7)
      c.body = "late-body"; // seed 17's `body` op (0.7: throws post-commit)
    });
    app.get("/r", (c) => c.json({ a: 1 }, 200));
    const res = await app.handle(new Request("http://localhost/r", { method: "HEAD" }));
    expect(res).toBeInstanceOf(Response);
    expect(res.body).toBe(null); // RED: bodied 500 today
    expect(onerror).toBe(1); // RED: ~1357 fires today
  }, 10_000);

  it("R6-4 [INV-1/INV-9] the error-path recursion must not leak unhandled rejections", async () => {
    // Same poison as R6-1, thrown from a MIDDLEWARE. Whether the stack
    // overflow lands inside errorResponse's protected try/catch or inside the
    // bare `out.catch(() => staticServerError())` arrow (dispatch.ts:232)
    // depends on the caller's stack depth — for callers at the wrong depth
    // (this test's shape) the RangeError escapes the framework entirely as
    // an UNHANDLED promise rejection. Under a real server an unhandled
    // rejection can take the worker down; the never-reject contract on
    // app.handle must extend to everything it kicks off.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    (process.on as unknown as (event: string, fn: (reason: unknown) => void) => void)(
      "unhandledRejection",
      onUnhandledRejection,
    );
    const app = new Keala({ ...quiet });
    let onerror = 0;
    app.onError(() => {
      onerror++;
    });
    app.use((c) => {
      c.setHeader("x-unicode", "café中");
      throw new Error("handler boom");
    });
    app.get("/e", (c) => c.text("never"));
    const res = await app.handle(new Request("http://localhost/e"));
    const body = await res.text(); // RED today: unhandled RangeError escapes here
    (process.off as unknown as (event: string, fn: (reason: unknown) => void) => void)(
      "unhandledRejection",
      onUnhandledRejection,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(res.status).toBe(500);
    expect(body).toBe("Internal Server Error");
    expect(onerror).toBe(1);
    expect(unhandled).toEqual([]); // RED: escaped RangeError(s) today
  }, 10_000);
});
