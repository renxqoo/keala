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

const decode = (input: string): string => {
  try {
    return decodeURIComponent(input.replace(/\+/g, " "));
  } catch {
    return input;
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
