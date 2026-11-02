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
export const decode = (input: string): string => {
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

/**
 * Boundary-matched targeted scan for one query key: the match must start at
 * the beginning of the query string or right after a `&`, and the key must
 * be followed by `=` — `page` never matches inside `pagesize`. Returns the
 * RAW (still-encoded) value slice, or null when absent.
 */
const findQueryEntry = (
  input: string,
  name: string,
  from: number,
): { start: number; end: number } | null => {
  const wanted = name.length;
  for (let at = from; ;) {
    const hit = input.indexOf(name, at);
    if (hit === -1) return null;
    const boundaryBefore = hit === 0 || input.charCodeAt(hit - 1) === 38; /* "&" */
    const after = hit + wanted;
    const next = after < input.length ? input.charCodeAt(after) : -1;
    // `a=1`, a bare trailing `a`, and `a&next=1` are all the pair `a` with
    // value "" for the latter two — the koa/hono observable semantics.
    const boundaryAfter = next === 61 /* "=" */ || next === 38 /* "&" */ || next === -1;
    if (boundaryBefore && boundaryAfter && wanted > 0) {
      let end = input.indexOf("&", after);
      if (end === -1) end = input.length;
      return { start: next === 61 ? after + 1 : after, end };
    }
    at = hit + 1;
  }
};

/**
 * The wire form of a key: clients send either the raw characters or their
 * encodeURIComponent form — a scan over the raw string must find both or
 * encoded keys (the hostile-parameter norm) would become invisible. The
 * encoded retry only runs after a raw miss, so the plain hot path never
 * pays the encode.
 */
/**
 * The wire forms of a query key, memoized (bounded): hot routes read the
 * same handful of keys every request, and the encode+split work was
 * measurable self-time on the query scenario. Beyond the cap, dynamic key
 * sprawl falls back to computing per call.
 */
const WIRE_FORMS_MAX = 256;
const wireFormsCache = new Map<string, string[]>();

const wireForms = (name: string): string[] => {
  const memo = wireFormsCache.get(name);
  if (memo !== undefined) return memo;
  const encoded = encodeURIComponent(name);
  // `+` is the form-encoding of a space IN KEYS as well: `?user+name=1` is
  // exactly what a browser sends for a field named "user name".
  const plus = name.includes(" ") ? name.replaceAll(" ", "+") : null;
  const forms =
    encoded === name
      ? plus === null
        ? [name]
        : [name, plus]
      : plus === null
        ? [name, encoded]
        : [name, encoded, plus];
  if (wireFormsCache.size < WIRE_FORMS_MAX) wireFormsCache.set(name, forms);
  return forms;
};

/** Decode one targeted value (the shared `decode` early-outs on plain runs). */
export const findQueryValue = (input: string, name: string): string | undefined => {
  if (input.length === 0 || name.length === 0) return undefined;
  for (const form of wireForms(name)) {
    const entry = findQueryEntry(input, form, 0);
    if (entry !== null) return decode(input.slice(entry.start, entry.end));
  }
  return undefined;
};

export const findAllQueryValues = (input: string, name: string): string[] => {
  if (input.length === 0 || name.length === 0) return [];
  const out: string[] = [];
  for (const form of wireForms(name)) {
    let at = 0;
    for (;;) {
      const entry = findQueryEntry(input, form, at);
      if (entry === null) break;
      out.push(decode(input.slice(entry.start, entry.end)));
      at = entry.end;
    }
  }
  return out;
};
