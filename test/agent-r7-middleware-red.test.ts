/**
 * Round 7 middleware/helper functional audit — assertion-red regressions.
 *
 * Every case below asserts the documented/standard behavior. They are kept
 * in one isolated file so each finding can be run independently while src/
 * remains untouched.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Eleu } from "../src/core/app.ts";
import { logger } from "../src/middleware/headers.ts";
import { serveStatic } from "../src/middleware/serve-static.ts";
import { createBodyParser, type ContextWithBody } from "../src/plugins/body-parser.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost:3000${path}`, init);

describe("R7 middleware/helper functional regressions [RED]", () => {
  it("bodyParser memoizes the parsed json result, not only the raw bytes", async () => {
    /*
     * Reproduction: two onion consumers call json() for the same request.
     * Expected: DESIGN §4.6's bodyCache.json memoization returns one object.
     * Actual: JSON.parse runs on every call, producing two distinct objects.
     * Root cause: body-parser.ts's facade memoizes only cache.bytes/cache.facade;
     *             json() never stores its parsed result in BodyCacheState.
     */
    const app = new Eleu(quiet);
    app.use(createBodyParser());
    app.post("/json", async (c0) => {
      const c = c0 as ContextWithBody;
      const first = await c.req.json();
      const second = await c.req.json();
      c.body = first === second ? "same" : "different";
    });

    const res = await app.handle(
      req("/json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"n":1}',
      }),
    );
    expect(await res.text()).toBe("same");
  });

  it("formPartLimit=0 accepts an empty urlencoded form (zero parsed parts)", async () => {
    /*
     * Reproduction: parse an empty urlencoded body with a zero-part budget.
     * Expected: an empty FormData has zero entries and fits the configured cap.
     * Actual: the request is rejected 413 as if it contained one part.
     * Root cause: body-parser.ts computes urlencoded parts as ampersands + 1
     *             even when bytes.length is zero.
     */
    const app = new Eleu(quiet);
    app.use(createBodyParser({ formPartLimit: 0 }));
    app.post("/form", async (c0) => {
      const c = c0 as ContextWithBody;
      const form = await c.req.formData();
      let entries = 0;
      form.forEach(() => {
        entries += 1;
      });
      c.body = String(entries);
    });

    const res = await app.handle(
      req("/form", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0");
  });

  it("bodyParser rejects NaN byte/part limits at construction", () => {
    /*
     * Reproduction: configure jsonLimit with NaN from dynamic JS/config input.
     * Expected: a max-byte limit must be a non-negative finite number.
     * Actual: construction succeeds and every `size > NaN` check is false,
     *         silently disabling the documented request-size bound.
     * Root cause: body-parser.ts validates only `limit < 0`, which misses NaN.
     */
    expect(() => createBodyParser({ jsonLimit: Number.NaN })).toThrow(TypeError);
  });

  it("serveStatic treats prefix '/' as the root mount", async () => {
    /*
     * Reproduction: mount a static directory at the canonical root prefix '/'.
     * Expected: /asset.txt is inside that prefix and serves the file.
     * Actual: it falls through to the app's 404 response.
     * Root cause: serve-static.ts tests startsWith(`${prefix}/`), which becomes
     *             startsWith('//') for prefix '/' and matches no normal path.
     */
    const root = mkdtempSync(join(tmpdir(), "bk-r7-static-"));
    try {
      writeFileSync(join(root, "asset.txt"), "root-prefix-ok");
      const app = new Eleu(quiet);
      app.use(serveStatic({ root, prefix: "/" }));

      const res = await app.handle(req("/asset.txt"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("root-prefix-ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("logger writes exactly one line when downstream throws", async () => {
    /*
     * Reproduction: a routed handler throws a plain Error under logger().
     * Expected: the module's 'one line per request' contract includes failures.
     * Actual: the framework returns 500 but the logging sink receives no line.
     * Root cause: headers.ts awaits next() before write() without catch/finally,
     *             so rejection skips the only write call.
     */
    const lines: string[] = [];
    const app = new Eleu(quiet);
    app.use(logger({ write: (line) => lines.push(line) }));
    app.get("/boom", () => {
      throw new Error("boom");
    });

    const res = await app.handle(req("/boom"));
    expect(res.status).toBe(500);
    expect(lines).toHaveLength(1);
  });
});
