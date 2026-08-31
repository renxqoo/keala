/**
 * Query string parsing.
 *
 * Mirrors Node's `querystring.parse` observable behavior used by Koa
 * (`ctx.query`): single values stay strings, repeated keys become arrays.
 * The result object always has a null prototype and the dangerous keys
 * `__proto__`, `constructor` and `prototype` are dropped, which makes
 * prototype pollution through crafted URLs impossible.
 */

export type QueryValue = string | string[];
export type QueryMap = Record<string, QueryValue>;

const HEX_PAIR = /^[0-9a-fA-F]{2}$/;

/** decodeURIComponent over one run of consecutive VALID escapes, verbatim on failure. */
const decodeRun = (run: string): string => {
  try {
    return decodeURIComponent(run);
  } catch {
    return run;
  }
};

/**
 * Node `querystring` recovery semantics: `+` is a space and each escape is
 * decoded independently, so a single malformed `%ZZ` stays verbatim WITHOUT
 * disabling the valid escapes around it. Consecutive valid escapes are
 * decoded as one run so multi-byte UTF-8 sequences (`%E4%B8%AD`) reassemble.
 */
const decode = (input: string): string => {
  const s = input.includes("+") ? input.replaceAll("+", " ") : input;
  if (!s.includes("%")) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    let out = "";
    let run = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i] as string;
      if (ch === "%" && i + 2 < s.length && HEX_PAIR.test(s.slice(i + 1, i + 3))) {
        run += s.slice(i, i + 3);
        i += 3;
        continue;
      }
      if (run.length > 0) {
        out += decodeRun(run);
        run = "";
      }
      out += ch;
      i++;
    }
    if (run.length > 0) out += decodeRun(run);
    return out;
  }
};

const isUnsafeKey = (key: string): boolean =>
  key === "__proto__" || key === "constructor" || key === "prototype";

export const parseQuery = (search: string): QueryMap => {
  const out: QueryMap = Object.create(null) as QueryMap;
  const input = search.charCodeAt(0) === 63 /* "?" */ ? search.slice(1) : search;
  if (input.length === 0) return out;

  // Single pass over the string: each character is visited exactly once.
  // (`indexOf("=")` restarts per segment and scans to the end of the string
  // when the remainder holds no "=", which made crafted keys-only queries
  // like `?a&a&a&...` parse in O(n^2).)
  let start = 0;
  let eq = -1;
  for (let i = 0; i <= input.length; i++) {
    const code = i === input.length ? 38 /* sentinel "&" */ : input.charCodeAt(i);
    if (code === 38 /* "&" */) {
      if (i > start) {
        const rawKey = eq === -1 ? input.slice(start, i) : input.slice(start, eq);
        const rawValue = eq === -1 ? "" : input.slice(eq + 1, i);
        const key = decode(rawKey);
        if (!isUnsafeKey(key)) {
          const value = decode(rawValue);
          const previous: QueryValue | undefined = out[key];
          if (previous === undefined) {
            out[key] = value;
          } else if (Array.isArray(previous)) {
            previous.push(value);
          } else {
            out[key] = [previous, value];
          }
        }
      }
      start = i + 1;
      eq = -1;
    } else if (code === 61 /* "=" */ && eq === -1) {
      eq = i;
    }
  }
  return out;
};
