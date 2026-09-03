/**
 * Unicode-confusion probes (NFKC folding, fullwidth homoglyphs) — split
 * from agent-security-audit for the 500-line budget.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { parseQuery } from "../src/utils/query.ts";
import { parseCookies } from "../src/index.ts";
import { validateHeaderName } from "../src/utils/text.ts";

const quiet = { env: "test" } as const;
const drive = async (app: InstanceType<typeof Keala>, url: string): Promise<Response> =>
  app.handle(new Request(url));

const FULLWIDTH_PROTO = "＿＿ｐｒｏｔｏ＿＿"; // U+FF3F/U+FF50 variants

describe("audit: unicode confusion (no normalization bypass)", () => {
  it("a fullwidth proto key NFKC-folds to __proto__ but stays inert here", async () => {
    // Document the attack intent: NFKC would fold the key to `__proto__`.
    expect(FULLWIDTH_PROTO.normalize("NFKC")).toBe("__proto__");
    const app = new Keala(quiet);
    let folded: string | undefined = "unset";
    let literal: string | undefined = "unset";
    app.use((c) => {
      // NFKC must NOT be applied: the fullwidth key stays a distinct literal
      // (findable by its own name), never folding onto __proto__.
      folded = c.query("__proto__");
      literal = c.query(FULLWIDTH_PROTO);
      c.body = "ok";
    });
    const res = await drive(
      app,
      `http://localhost:3000/?${encodeURIComponent(FULLWIDTH_PROTO)}=1&ok=2`,
    );
    expect(res.status).toBe(200);
    expect(folded).toBeUndefined(); // no NFKC fold onto __proto__
    expect(literal).toBe("1"); // the fullwidth literal stays its own key
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("fullwidth period in a path never folds into a traversal dot", async () => {
    const app = new Keala(quiet);
    let path = "";
    app.use((c) => {
      path = c.path;
      c.body = "ok";
    });
    // %EF%BC%8E is U+FF0E FULLWIDTH FULL STOP.
    await drive(app, "http://localhost:3000/a%EF%BC%8E%EF%BC%8E/b");
    expect(path).toBe("/a%EF%BC%8E%EF%BC%8E/b"); // no decode, no folding
    expect(decodeURIComponent("%EF%BC%8E").normalize("NFKC")).toBe(".");
    expect(decodeURIComponent("/a%EF%BC%8E%EF%BC%8E/b")).not.toContain("..");
  });

  it("overlong UTF-8 percent escapes never decode into metacharacters", () => {
    // %C0%AF is an overlong encoding of "/"; decoders must reject it.
    const parsed = parseQuery("?x=%C0%AF..%C0%AFetc");
    expect(parsed["x"]).not.toContain("/");
    expect(parsed["x"]).toBe("%C0%AF..%C0%AFetc");
  });

  it("fullwidth and homoglyph header names are rejected as invalid tokens", () => {
    expect(() => validateHeaderName("Ｘ-Evil")).toThrow(TypeError); // U+FF38
    expect(() => validateHeaderName("x\u200bevil")).toThrow(TypeError); // ZWSP
    expect(() => validateHeaderName("x‑forwarded‑for")).toThrow(TypeError); // U+2011
  });

  it("fullwidth cookie names are dropped by the parser (ASCII tokens only)", () => {
    const jar = parseCookies(`${FULLWIDTH_PROTO}=1; ｓｅｓｓｉｏｎ=x; session=ok`);
    expect(jar["session"]).toBe("ok");
    expect(Object.keys(jar)).toEqual(["session"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Negotiation/cookie parser complexity locks.
// ---------------------------------------------------------------------------
