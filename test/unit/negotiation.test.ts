import { describe, expect, it } from "vitest";

import {
  acceptableValues,
  acceptsCharset,
  acceptsEncoding,
  acceptsLanguage,
  acceptsType,
  parsePreferences,
  pickPreference,
} from "../../src/negotiation/accepts.ts";
import { Keala } from "../../src/core/app.ts";
import { createBodyParser } from "../../src/plugins/body-parser.ts";
import { validator } from "../../src/middleware/validator.ts";
import type { Context } from "../../src/core/context/context.ts";

describe("parsePreferences", () => {
  it("orders by q-value and original order", () => {
    const prefs = parsePreferences("text/html;q=0.5, application/json, text/plain;q=0.9");
    expect(prefs.map((p) => p.value)).toEqual(["application/json", "text/plain", "text/html"]);
  });

  it("drops q=0 entries and clamps q to [0,1]", () => {
    const prefs = parsePreferences("gzip;q=0, br;q=9, deflate;q=-1, identity");
    expect(prefs.map((p) => p.value)).toEqual(["br", "identity"]);
    expect(prefs.map((p) => p.q)).toEqual([1, 1]);
  });

  it("handles quoted strings with commas", () => {
    const prefs = parsePreferences('a;q=1, "b,c";q=0.5, d');
    expect(prefs.map((p) => p.value)).toEqual(["a", "d", '"b,c"']);
  });

  it("returns empty for missing headers", () => {
    expect(parsePreferences(null)).toEqual([]);
    expect(parsePreferences("")).toEqual([]);
  });
});

describe("acceptsType", () => {
  it("picks exact match", () => {
    expect(acceptsType("text/html,application/xhtml+xml", ["application/json", "text/html"])).toBe(
      "text/html",
    );
  });

  it("falls back through subtype wildcards", () => {
    expect(acceptsType("text/*,application/json", ["application/xml", "application/json"])).toBe(
      "application/json",
    );
    expect(acceptsType("text/*", ["application/json", "text/html"])).toBe("text/html");
  });

  it("global wildcard matches anything", () => {
    expect(acceptsType("*/*", ["application/json"])).toBe("application/json");
    expect(acceptsType("*", ["application/json"])).toBe("application/json");
  });

  it("respects q-values", () => {
    expect(
      acceptsType("application/json;q=0.8, text/html;q=0.9", ["text/html", "application/json"]),
    ).toBe("text/html");
    expect(
      acceptsType("application/json;q=0.9, text/html;q=0.8", ["text/html", "application/json"]),
    ).toBe("application/json");
  });

  it("returns false when nothing matches", () => {
    expect(acceptsType("application/json", ["text/html"])).toBe(false);
  });

  it("returns first provided when header missing", () => {
    expect(acceptsType(null, ["text/html", "application/json"])).toBe("text/html");
  });
});

describe("acceptsEncoding / acceptsCharset / acceptsLanguage", () => {
  it("encoding negotiation", () => {
    expect(acceptsEncoding("gzip, compress;q=0.5, br;q=0", ["gzip", "br", "identity"])).toBe(
      "gzip",
    );
    expect(acceptsEncoding("br;q=0, gzip", ["gzip", "br"])).toBe("gzip");
    // Absent header → identity only (RFC 7231 §5.3.4 / negotiator, verified
    // live): never the server's first provided coding.
    expect(acceptsEncoding(null, ["gzip", "br"])).toBe(false);
    expect(acceptsEncoding(null, ["gzip", "identity"])).toBe("identity");
  });

  it("charset negotiation", () => {
    expect(acceptsCharset("utf-8, iso-8859-1;q=0.5", ["utf-8", "iso-8859-1"])).toBe("utf-8");
  });

  it("language prefix matching", () => {
    // negotiator: "en"'s quality is 0.8 (its exact range beats the en-GB
    // prefix), "zh" carries zh-CN's 0.9 — zh wins.
    expect(acceptsLanguage("en-GB,en;q=0.8,zh-CN;q=0.9", ["zh", "en", "fr"])).toBe("zh");
    expect(acceptsLanguage("zh-CN;q=1, en-GB;q=0.5", ["zh", "en"])).toBe("zh");
    expect(acceptsLanguage("en;q=0.5, zh", ["en", "zh"])).toBe("zh");
  });
});

describe("acceptableValues", () => {
  it("lists client preferences best-first", () => {
    expect(acceptableValues("text/html;q=0.4, application/json")).toEqual([
      "application/json",
      "text/html",
    ]);
  });
});

describe("pickPreference", () => {
  it("returns false when provided list empty", () => {
    expect(
      pickPreference({ header: "text/html", provided: [], normalize: (v) => v, score: () => 0 }),
    ).toBe(false);
  });
});

/**
 * ROUND 5 PARSER AUDIT — confirmed-bug red tests (negotiation specificity,
 * media-range parameters, validator issue rendering). Locks-correct halves
 * split into agent-r5-parsers-request/-body/-server for the 500-line budget.
 */

const quiet = { env: "test" } as const;
const drive = (app: InstanceType<typeof Keala>, req: Request) => app.handle(req);

/** Run one request through global middleware and hand the context back. */
const probe = async (
  headers: Record<string, string>,
  fn: (c: Context) => unknown,
  opts: Record<string, unknown> = {},
  url = "http://x/",
): Promise<unknown> => {
  const app = new Keala({ ...quiet, ...opts });
  let captured: Context | undefined;
  app.use(async (c) => {
    captured = c;
  });
  await drive(app, new Request(url, { headers }));
  return fn(captured as Context);
};

describe("R1 (bug): negotiator breaks q-ties on match specificity, not header order", () => {
  it("accepts: `Accept: */*, text/html` prefers text/html over an earlier-matching wildcard", async () => {
    // negotiator.mediaTypes(['application/json','text/html'])[0] === 'text/html':
    // compareSpecs sorts (q, s, o, i) — text/html matched with s=6 (exact)
    // outranks application/json's s=2 (*/* wildcard) at the same q=1.
    // pickPreference only compares header order on q ties → returns json.
    const picked = await probe({ accept: "*/*, text/html" }, (c) =>
      c.accepts(["application/json", "text/html"]),
    );
    expect(picked).toBe("text/html");
  });

  it("accepts: `Accept: text/*, text/html` prefers text/html at equal q", async () => {
    // negotiator.mediaTypes(['text/plain','text/html'])[0] === 'text/html'.
    const picked = await probe({ accept: "text/*;q=1, text/html;q=1" }, (c) =>
      c.accepts(["text/plain", "text/html"]),
    );
    expect(picked).toBe("text/html");
  });

  it("acceptsEncodings: `Accept-Encoding: *, gzip` prefers gzip over br", async () => {
    // negotiator.encodings(['br','gzip'])[0] === 'gzip' (exact s=1 beats the
    // wildcard s=0 at q=1).
    const picked = await probe({ "accept-encoding": "*, gzip" }, (c) =>
      c.acceptsEncodings(["br", "gzip"]),
    );
    expect(picked).toBe("gzip");
  });

  it("acceptsCharset: `Accept-Charset: *, utf-8` prefers utf-8 over ascii", async () => {
    // 0.7: the c.acceptsCharsets accessor is gone; the shared helper (the
    // unit lock below) carries the same specificity contract.
    expect(acceptsCharset("*, utf-8", ["ascii", "utf-8"])).toBe("utf-8");
  });

  it("unit level: acceptsType/acceptsEncoding miss the specificity key", () => {
    expect(acceptsType("*/*, text/html", ["application/json", "text/html"])).toBe("text/html");
    expect(acceptsEncoding("*, gzip", ["br", "gzip"])).toBe("gzip");
    expect(acceptsCharset("*, utf-8", ["ascii", "utf-8"])).toBe("utf-8");
  });
});

// ---------------------------------------------------------------------------
// R2 — client media-range parameters (RED)
// ---------------------------------------------------------------------------

describe("R2 (bug): a param'd Accept range must not match the bare server type", () => {
  it("`Accept: text/html;level=1` alone matches nothing provided (koa → 406)", async () => {
    // negotiator.specify(): for a range with params, every param must be
    // present-and-equal on the server type, else `return null` — the range
    // simply does not apply. negotiator.mediaTypes(['text/html',
    // 'application/json']) → [] under this header.
    const picked = await probe({ accept: "text/html;level=1" }, (c) =>
      c.accepts(["text/html", "application/json"]),
    );
    expect(picked).toBe(false);
  });

  it("shorthand form: c.accepts(['html','json']) under the same header → false", async () => {
    const picked = await probe({ accept: "text/html;level=1" }, (c) => c.accepts(["html", "json"]));
    expect(picked).toBe(false);
  });

  it("a param'd range must not steal the quality of the bare range's match", async () => {
    // RFC 7231 §5.3.2 / negotiator: for server type text/html only the bare
    // `text/html` range applies (q=1) — the ;level=1 range (q=0.1) does not
    // — so text/html (q=1) beats application/json (q=0.5).
    const picked = await probe(
      { accept: "text/html;level=1;q=0.1, application/json;q=0.5, text/html" },
      (c) => c.accepts(["text/html", "application/json"]),
    );
    expect(picked).toBe("text/html");
  });
});

// ---------------------------------------------------------------------------
// R3 — validator issue rendering (RED)
// ---------------------------------------------------------------------------

describe("R3 (bug): validator renders malformed issues instead of crashing", () => {
  it("a null entry in `issues` yields an exposed 400, not a 500", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser());
    const schema = {
      "~standard": {
        version: 1 as const,
        validate: () => ({ issues: [null, { message: 42 }] }),
      },
    };
    app.post("/", validator(schema), (c) => c.text("unreachable"));
    const res = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid value");
  });
});
