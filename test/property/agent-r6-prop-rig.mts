/**
 * ROUND 6 property rig, part 1 — split from the original agent-r6-prop
 * harness for the 500-line file budget; imported by agent-r6-prop*.test.ts.
 */

/**
 * ROUND 6 AUDIT — property-invariant fuzzing (zero new dependencies).
 *
 * Rig
 * ---
 * - Deterministic mulberry32 PRNG; sample `seed` uses stream `ROOT_SEED + seed`
 *   so every failure is reproducible by re-running exactly that seed number.
 * - Generators: randString (configurable alphabets: printable / controls /
 *   percent / UTF-8 incl. surrogate pairs / oversized), randPath (random
 *   segment counts, valid+invalid+double %-escapes, mixed-case hex, slash
 *   repetition, dot segments), randHeaders (token/CRLF-attempt/unicode/long),
 *   randMiddleware (onion behaviors: next / early Response / header writes /
 *   status / throws of arbitrary values / thenables / delays / double next).
 * - `runProp` executes N seeds per property, tags any assertion failure with
 *   its seed, and counts skipped samples (inputs `new Request` itself rejects
 *   are generator artifacts, not framework failures).
 *
 * The 11 invariants under test are numbered INV-1..INV-11 in the describe
 * titles. Confirmed violations are minimized into fixed-seed red `it`s in the
 * last describe (source is NOT modified — red tests are the deliverable).
 */

export const quiet = { env: "test" } as const;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------

export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export class Rng {
  private readonly nextFloat: () => number;
  constructor(seed: number) {
    this.nextFloat = mulberry32(seed);
  }
  float(): number {
    return this.nextFloat();
  }
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    return Math.floor(this.nextFloat() * maxExclusive);
  }
  /** Uniform integer in [min, maxInclusive]. */
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }
  bool(p = 0.5): boolean {
    return this.nextFloat() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
}

export const ROOT_SEED = 0x5eed06;

// ---------------------------------------------------------------------------
// Alphabets + string generators
// ---------------------------------------------------------------------------

export const CTL =
  "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f" +
  "\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x7f";
export const TOKEN =
  "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const PRINTABLE = TOKEN + " (){}[];:,<>?/\\\"'`@=+|";
export const UNICODE = "éüñç中文日本語한ᚠ𐌰😀𝕬"; // includes a surrogate pair (😀)
export const SEG = "abcdefghijklmnopqrstuvwxyz0123456789-_.";

export const randString = (rng: Rng, maxLen: number, alphabet: string): string => {
  let out = "";
  const n = rng.int(maxLen + 1);
  for (let i = 0; i < n; i++) out += alphabet[rng.int(alphabet.length)];
  return out;
};

export const encoder = new TextEncoder();
/** Valid percent-escape of one code point (upper-case hex, UTF-8 bytes). */
export const pctOf = (ch: string): string =>
  Array.from(encoder.encode(ch), (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(
    "",
  );

// ---------------------------------------------------------------------------
// Header generators
// ---------------------------------------------------------------------------

export const randHeaderValue = (rng: Rng): string => {
  switch (rng.int(7)) {
    case 0:
      return randString(rng, 24, TOKEN);
    case 1:
      return randString(rng, 24, CTL); // CRLF / NUL smuggling attempts
    case 2:
      return randString(rng, 24, UNICODE); // non-latin-1
    case 3:
      return randString(rng, 300, PRINTABLE); // oversized
    case 4:
      return randString(rng, 24, TOKEN + CTL);
    case 5:
      return randString(rng, 24, "%\r\n\x00 \t;,/\\");
    default:
      return "";
  }
};

export const NAMED_HEADERS = [
  "set-cookie",
  "content-type",
  "content-length",
  "location",
  "vary",
  "etag",
  "allow",
  "x-custom",
  "__proto__",
  "constructor",
  "prototype",
  "Set-Cookie",
] as const;

export const randHeaderName = (rng: Rng): string => {
  switch (rng.int(6)) {
    case 0:
      return randString(rng, 12, TOKEN);
    case 1:
      return randString(rng, 12, TOKEN + CTL);
    case 2:
      return randString(rng, 12, TOKEN + UNICODE);
    case 3:
      return randString(rng, 8, "x-") + randString(rng, 8, TOKEN);
    case 4:
      return rng.pick(NAMED_HEADERS);
    default:
      return randString(rng, 3, TOKEN) + rng.pick(["\r\n", "%", "\x00", "/", " "]);
  }
};

/** Request-side headers: mostly constructor-valid (invalid ones count as skips). */
export const randRequestHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {};
  const n = 2;
  for (let i = 0; i < n; i++) {
    headers[`x-r6-${i}`] = randHeaderValue(new Rng(ROOT_SEED + 977 + i * 31));
  }
  return headers;
};

// ---------------------------------------------------------------------------
// Path / URL generators
// ---------------------------------------------------------------------------

export const randSegment = (rng: Rng): string => {
  const base = randString(rng, 6, SEG);
  switch (rng.int(11)) {
    case 0:
      return base;
    case 1:
      return base + pctOf(rng.pick(["/", " ", "%"])); // %2F %20 %25
    case 2:
      return rng.pick(["%2F", "%2f", "%20", "%25", "%2E", "%61"]);
    case 3:
      return rng.pick(["%zz", "%", "%2", "%%", "%0", "a%"]); // invalid escapes
    case 4:
      return rng.pick(["%252F", "%2541", "%2520", "%25%32%46"]); // double-encoded
    case 5:
      return rng.pick(["..", ".", "..."]);
    case 6:
      return base + randString(rng, 3, UNICODE);
    case 7:
      return base + pctOf(rng.pick(["é", "中", "\x00", "\r\n"])); // encoded controls
    case 8:
      return base.toUpperCase() + "%2f";
    case 9:
      return base + rng.pick(["?", "#", "&", "=", "+"]); // raw specials
    default:
      return pctOf(base);
  }
};

export const randPath = (rng: Rng): string => {
  const segs = Array.from({ length: rng.range(0, 5) }, () => randSegment(rng));
  let p = "/";
  for (const s of segs) {
    p += s;
    p += rng.bool(0.15) ? "//" : "/";
  }
  if (segs.length > 0 && rng.bool(0.2)) p = p.slice(0, -1); // drop trailing slash
  if (rng.bool(0.08)) p += rng.pick(["..", ".", "../.."]);
  return p;
};

export const randQueryKey = (rng: Rng): string => {
  switch (rng.int(6)) {
    case 0:
      return randString(rng, 8, TOKEN);
    case 1:
      return rng.pick(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]);
    case 2:
      return rng.pick(["%5f%5fproto%5f%5f", "%63onstructor", "proto"]);
    case 3:
      return randString(rng, 8, TOKEN + CTL);
    case 4:
      return randString(rng, 8, TOKEN + UNICODE + "%&=");
    default:
      return "";
  }
};

export const randQueryString = (rng: Rng): string => {
  const parts: string[] = [];
  const n = rng.range(0, 5);
  for (let i = 0; i < n; i++) {
    const key = randQueryKey(rng);
    const value = randString(rng, 10, TOKEN + CTL + UNICODE + "%+");
    parts.push(rng.bool(0.2) ? key : `${key}=${value}`);
  }
  return parts.join("&");
};

export const METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "get",
  "PoSt",
  "CUSTOM",
  "PROPFIND",
] as const;

/** Build a random Request; null when the Request constructor refuses the URL. */
export const tryRequest = (rng: Rng, url: string, withBody: boolean): Request | null => {
  try {
    const method = rng.pick(METHODS);
    const init: RequestInit = { method, headers: randRequestHeaders() };
    if (withBody && method !== "GET" && method !== "HEAD") {
      init.body = rng.bool(0.5)
        ? JSON.stringify({
            __proto__: undefined,
            a: randString(rng, 8, PRINTABLE),
            nested: { deep: [1, 2, 3] },
          })
        : randString(rng, 64, PRINTABLE + UNICODE);
    }
    return new Request(url, init);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Middleware / handler behavior generators
// ---------------------------------------------------------------------------

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const REDIRECT_TARGETS = [
  "/",
  "/ok",
  "//evil.com/x",
  "/\\evil.com",
  "https:/evil.com",
  "https://ok.example/x",
  "/t?next=" + encodeURIComponent("/中?x=1"),
  "back",
  "/ré" + "sumé",
  "/" + randString(new Rng(ROOT_SEED + 4242), 40, PRINTABLE + CTL),
] as const;

export const COOKIE_NAMES = ["sid", "session", "a", "token", "phpsessid", "x"] as const;

export const randCookieHeader = (rng: Rng): string => {
  const parts: string[] = [];
  const n = rng.range(0, 4);
  for (let i = 0; i < n; i++) {
    const name = rng.pick(COOKIE_NAMES);
    const evil = rng.pick([
      "__proto__",
      "constructor",
      "%5f%5fproto%5f%5f",
      "a\x00b",
      " a ",
      "a=b",
      `v${i}`,
    ]);
    parts.push(`${name}=${evil}${rng.bool(0.3) ? "" : "; path=/"}`);
  }
  return parts.join("; ");
};

/** Random but header-valid writes (never throws). */
