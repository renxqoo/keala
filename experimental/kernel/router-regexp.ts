/** Isolated small-table candidate; the existing trie remains the cold reference. */
import {
  canonical,
  compileRoutes,
  EMPTY_PARAMS,
  pathOf,
  type Call,
  type Definition,
  type Endpoint,
  type Selection,
} from "./router.ts";

const LIMIT = 64;
const SOURCE_LIMIT = 16 * 1024;
const compileFailure = (error: unknown) =>
  error instanceof SyntaxError || error instanceof RangeError;
// Unlike $, this cannot succeed before a final newline (or any other code unit).
const END = "(?![\\s\\S])";
const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
interface Plan {
  readonly endpoint: Endpoint;
  readonly names: readonly string[];
  readonly rank: readonly number[];
  readonly source: string;
  first: number;
}
interface Table {
  exact: Map<string, Call>;
  plans: Plan[];
  regexp?: RegExp;
}
const precedence = (left: Plan, right: Plan): number => {
  const length = Math.min(left.rank.length, right.rank.length);
  for (let i = 0; i < length; i++) {
    const difference = left.rank[i]! - right.rank[i]!;
    if (difference) return difference;
  }
  // At a shared terminal the route itself wins before its empty wildcard child.
  return left.rank.length - right.rank.length;
};

export const compileRoutesRegExp = (
  definitions: readonly Definition[],
): ((method: string, url: string) => Selection) => {
  // Validation must remain identical, including aliases, duplicate shapes,
  // unsupported syntax and eager URI errors. No partial candidate is published.
  const fallback = compileRoutes(definitions);
  const tables = new Map<string, Table>();
  let dynamic = 0;
  for (const definition of definitions) {
    const path =
      definition.path.length > 1 && definition.path.endsWith("/")
        ? definition.path.slice(0, -1)
        : definition.path;
    const parts = path === "/" ? [] : path.slice(1).split("/");
    const endpoint = Object.freeze({ ...definition.endpoint }) as Endpoint;
    const names: string[] = [],
      rank: number[] = [];
    let source = "";
    for (const part of parts) {
      if (part.startsWith(":")) {
        names.push(part.slice(1));
        rank.push(1);
        source += "/([^/]+)";
      } else if (part.startsWith("*")) {
        names.push(part.slice(1) || "wildcard");
        rank.push(2);
        // The lookahead protects the segment boundary while always capturing
        // an empty string for a bare prefix. Each alternative's first capture
        // is therefore defined, even for /static/* matching /static.
        source += source ? `(?=/|${END})/?([\\s\\S]*)` : "/([\\s\\S]*)";
      } else {
        rank.push(0);
        source += "/" + literal(canonical(part));
      }
    }
    let table = tables.get(definition.method);
    if (!table) {
      table = { exact: new Map(), plans: [] };
      tables.set(definition.method, table);
    }
    if (!names.length) {
      const key = canonical(path);
      table.exact.set(
        key,
        Object.freeze({ kind: "route", endpoint, params: EMPTY_PARAMS, path: key }),
      );
    } else {
      if (++dynamic > LIMIT) return fallback;
      table.plans.push({
        endpoint,
        names: Object.freeze(names),
        rank: Object.freeze(rank),
        source,
        first: 0,
      });
    }
  }
  try {
    let sourceLength = 0;
    for (const table of tables.values()) {
      if (!table.plans.length) continue;
      table.plans.sort(precedence);
      let first = 1;
      for (const plan of table.plans) {
        plan.first = first;
        first += plan.names.length;
        Object.freeze(plan);
      }
      const source = `^(?:${table.plans.map((plan) => plan.source + END).join("|")})${END}`;
      sourceLength += source.length;
      if (sourceLength > SOURCE_LIMIT) return fallback;
      table.regexp = new RegExp(source);
    }
  } catch (error) {
    // Engine limits for unusual giant patterns must not change registration.
    if (!compileFailure(error)) throw error;
    return fallback;
  }
  return (rawMethod, url) => {
    const method = rawMethod.toUpperCase(),
      path = canonical(pathOf(url));
    if (!path.startsWith("/")) throw new URIError("unsupported request target");
    const table = tables.get(method);
    if (table) {
      const exact = table.exact.get(path);
      if (exact) return exact;
      let match: RegExpExecArray | null | undefined;
      try {
        match = table.regexp?.exec(path);
      } catch (error) {
        if (!compileFailure(error)) throw error;
        // V8 may accept construction but compile lazily on first execution.
        // Retire this method table permanently; URI errors still propagate.
        tables.delete(method);
        return fallback(rawMethod, url);
      }
      if (match) {
        for (const plan of table.plans) {
          if (match[plan.first] === undefined) continue;
          const params: Record<string, string> = Object.create(null);
          for (let i = 0; i < plan.names.length; i++) {
            const value = match[plan.first + i]!;
            params[plan.names[i]!] = value.includes("%") ? decodeURIComponent(value) : value;
          }
          return { kind: "route", endpoint: plan.endpoint, params, path };
        }
      }
    }
    // Use the original target, not the canonical path: decoding it again could
    // conflate literal %2F with an escaped slash. HEAD/ALL/Allow stay reference-owned.
    return fallback(rawMethod, url);
  };
};
