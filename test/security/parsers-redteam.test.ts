/**
 * RED-TEAM ROUND 3 — parser deep-dive (RED tests).
 *
 * Every `it` asserts the CORRECT behavior and FAILS against the current src/.
 * Do not "fix" these by flipping expectations — fix src/ instead.
 *
 * R3-1 [HIGH] src/middleware/serve-static.ts:151-165 — the symlink lstat walk
 *   iterates the components of `absolute` (the resolved DIRECTORY), not
 *   `filePath`; in the directory-index branch (line 140) filePath becomes
 *   <dir>/<index> and diverges from absolute, so a symlinked
 *   `subdir/index.html` is never lstat'd. With followSymlinks OFF (the
 *   default) the index symlink is followed straight out of root and its
 *   target is served => arbitrary file read. (The existing suite only covers
 *   a top-level file symlink, where absolute === filePath.)
 *
 * R3-2 [HIGH] src/plugins/body-parser.ts:55-67 — boundaryOf() splits the
 *   content-type on ";" with no quoted-string awareness. For
 *   `boundary="a;b"` the needle degenerates to `--"a` (zero hits), so
 *   countOccurrences - 1 = -1 never exceeds the limit and the multipart part
 *   budget (formPartLimit, default 1000) is silently disarmed — while
 *   Node/undici's FormData parser honors the real boundary `a;b` and
 *   materializes every part => memory-amplification DoS (a 10MB body of
 *   ~50-byte parts yields ~200k entry objects, 200x the configured budget).
 *
 * R3-3 [MEDIUM] src/negotiation/accepts.ts:104-129 — pickPreference selects
 *   the highest-q client preference first, but RFC 7231 §5.3.2 (and the
 *   negotiator package Koa uses) resolve each PROVIDED type by its MOST
 *   SPECIFIC matching range first and only then compare q: with
 *   "text/html;q=0.4, [global-wildcard];q=0.5" the quality of text/html is
 *   0.4 (the exact range outranks the wildcard's 0.5), so the other provided
 *   type must win. This implementation answers text/html. Same inversion
 *   for encodings, languages and charsets. Verified against negotiator:
 *   mediaType → application/json, encodings → br, languages → fr,
 *   charsets → latin1.
 *
 * R3-4 [MEDIUM] src/negotiation/accepts.ts:155-164 — isIdentityRefused()
 *   string-matches only "q=0" / "q=0.0" / "q=0.00" and only in the FIRST
 *   parameter slot. "identity;q=0.000", "identity;level=1;q=0" and
 *   "star;q=0.000" all refuse identity (parsePreferences clamps those q
 *   values to 0 and negotiator agrees) yet identity is still returned as
 *   acceptable — an encoding the client explicitly excluded gets used.
 *
 * R3-5 [MEDIUM] src/context/cookies.ts:41,68-91,94-107 — asymmetric cookie
 *   codec: serializeCookie emits values verbatim (no encodeURIComponent)
 *   while parseCookies always decodeURIComponent()s them. A browser echoing
 *   `tok=50%2Foff` (set verbatim by the framework) is read back as "50/off";
 *   a SIGNED cookie whose value contains a percent-escape can never be
 *   unsigned again (HMAC computed over the raw value, verified over the
 *   decoded one) => silent session loss. The cookies package Koa uses
 *   encodes on set and decodes on get, so values round-trip.
 *
 * R3-6 [LOW] src/context/cookies.ts:119-127 — serializeCookie accepts an
 *   INVALID Date (`new Date("not a date")`: the 400-day guard
 *   `NaN > MAX_COOKIE_AGE_MS` is false) and ships the literal header
 *   `Expires=Invalid Date`. response.ts' lastModified setter validates the
 *   exact same shape; the cookie serializer must too.
 */

import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import {
  acceptsCharset,
  acceptsEncoding,
  acceptsLanguage,
  acceptsType,
} from "../../src/negotiation/accepts.ts";
import { parseCookies, serializeCookie, sign, unsign } from "../../src/context/cookies.ts";
import { bodyOf, createBodyParser } from "../../src/plugins/body-parser.ts";
import { serveStatic } from "../../src/middleware/serve-static.ts";

const quiet = { env: "test" } as const;

/** A tiny-part multipart body with `count` fields delimited by `boundary`. */
const partsBody = (boundary: string, count: number): string => {
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="f${i}"\r\n\r\nx\r\n`);
  }
  chunks.push(`--${boundary}--\r\n`);
  return chunks.join("");
};

/**
 * The Cookie header a browser echoes back for a Set-Cookie pair: the
 * name=value segment, byte-for-byte as serialized.
 */
const echoedCookieHeader = (name: string, setCookie: string): string =>
  `${name}=${(setCookie.split(";")[0] ?? "").slice(name.length + 1)}`;

describe("R3-1 serveStatic: a symlinked subdirectory index escapes root", () => {
  let root = "";
  let outside = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "bk-r3-root-"));
    outside = await mkdtemp(join(tmpdir(), "bk-r3-out-"));
    await writeFile(join(outside, "loot.txt"), "TOP SECRET LOOT");
    await mkdir(join(root, "uploads"));
    // uploads/index.html is a symlink OUT of root — the exact thing the
    // lstat walk exists to catch with followSymlinks off (the default).
    await symlink(join(outside, "loot.txt"), join(root, "uploads", "index.html"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("denies <dir>/index.html symlinks with followSymlinks off (default)", async () => {
    const app = new Keala(quiet);
    app.use(serveStatic({ root }));
    const res = await app.handle(new Request("http://localhost:3000/uploads/"));
    expect(res.status).toBe(403); // same denial as the top-level link.js case
    expect(await res.text()).not.toContain("TOP SECRET LOOT");
  });
});

describe("R3-2 bodyParser: multipart part budget disarmed by `;` in a quoted boundary", () => {
  const appOf = () => {
    const app = new Keala(quiet);
    app.use(createBodyParser()); // formPartLimit defaults to 1000
    // The exposed 413 from the budget check renders through the standard
    // error path; a surviving budget materializes every part instead.
    app.use(async (c0) => {
      const fd = await bodyOf(c0).formData();
      c0.body = `parsed ${[...fd.keys()].length} parts`;
    });
    return app;
  };

  it("rejects >1000 parts when the boundary value contains a semicolon", async () => {
    // boundary="a;b": undici parses the boundary as `a;b`; boundaryOf() sees
    // the needle `"a` after its naive ";" split, counts 0 and disarms the
    // budget. The control (a sane boundary) must stay 413 — the semicolon
    // variant must be rejected exactly like it.
    const res = await appOf().handle(
      new Request("http://localhost:3000/x", {
        method: "POST",
        headers: { "content-type": 'multipart/form-data; boundary="a;b"' },
        body: partsBody("a;b", 1500),
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.text()).not.toContain("parsed 1500 parts");
  });
});

describe("R3-3 negotiation: specificity of a matching range outranks wildcard q", () => {
  it("acceptsType: exact range q=0.4 beats */* q=0.5 for text/html, so the other provided type wins", () => {
    // RFC 7231 §5.3.2: quality(text/html) = 0.4 (exact), quality(application/json) = 0.5 (wildcard).
    // negotiator answers application/json.
    expect(acceptsType("text/html;q=0.4, */*;q=0.5", ["text/html", "application/json"])).toBe(
      "application/json",
    );
  });

  it("acceptsEncodings: gzip's exact q=0.4 beats * q=0.5, so br must be picked", () => {
    expect(acceptsEncoding("gzip;q=0.4, *;q=0.5", ["gzip", "br"])).toBe("br");
  });

  it("acceptsLanguages: en's exact q=0.4 beats * q=0.5, so fr must be picked", () => {
    expect(acceptsLanguage("en;q=0.4, *;q=0.5", ["en", "fr"])).toBe("fr");
  });

  it("acceptsCharsets: utf-8's exact q=0.4 beats * q=0.5, so latin1 must be picked", () => {
    expect(acceptsCharset("utf-8;q=0.4, *;q=0.5", ["utf-8", "latin1"])).toBe("latin1");
  });
});

describe("R3-4 negotiation: identity refused with q=0 in any spelling/position", () => {
  it("identity;q=0.000 is a refusal (parsePreferences itself clamps it to 0)", () => {
    expect(acceptsEncoding("gzip;q=0, identity;q=0.000", ["gzip", "identity"])).toBe(false);
  });

  it("identity;level=1;q=0 is a refusal (q is not the first parameter)", () => {
    expect(acceptsEncoding("gzip;q=0, identity;level=1;q=0", ["gzip", "identity"])).toBe(false);
  });

  it("*;q=0.000 refuses identity just like *;q=0 does", () => {
    expect(acceptsEncoding("gzip;q=0, *;q=0.000", ["gzip", "identity"])).toBe(false);
  });
});

describe("R3-5 cookies: values must survive set → browser echo → parse", () => {
  it("unsigned values containing percent-escapes round-trip verbatim", () => {
    const setCookie = serializeCookie("tok", "50%2Foff");
    expect(parseCookies(echoedCookieHeader("tok", setCookie)).tok).toBe("50%2Foff");
  });

  it("signed values containing percent-escapes unsign after the echo", () => {
    const setCookie = serializeCookie("sid", sign("v%3D1", "k1"));
    const echoed = parseCookies(echoedCookieHeader("sid", setCookie)).sid ?? "";
    expect(unsign(echoed, ["k1"])).toBe("v%3D1");
  });
});

describe("R3-6 cookies: expires must be a VALID date", () => {
  it("rejects an invalid Date instead of shipping `Expires=Invalid Date`", () => {
    expect(() => serializeCookie("k", "v", { expires: new Date("not a date") })).toThrow(TypeError);
  });
});
