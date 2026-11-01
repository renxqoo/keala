import { Reply, type Params, type Result, type TextResult } from "./reply.ts";
export type TextHandler = (params: Params) => TextResult;
export type FetchHandler = (request: Request, params: Params) => Result;
export type Endpoint =
  | { readonly kind: "text"; readonly handler: TextHandler }
  | { readonly kind: "fetch"; readonly handler: FetchHandler };
type Segment = { kind: "static" | "param" | "wild"; value: string };
export interface Definition {
  readonly method: string;
  readonly path: string;
  readonly endpoint: Endpoint;
}
interface Plan {
  readonly endpoint: Endpoint;
  readonly names: readonly string[];
}
interface Node {
  static: Map<string, Node>;
  param?: Node;
  wild?: Node;
  plan?: Plan;
}
export interface Call {
  readonly kind: "route";
  readonly endpoint: Endpoint;
  readonly params: Params;
  readonly path: string;
}
export interface Miss {
  readonly kind: "miss";
  readonly reply: Reply;
  readonly path: string;
}
export type Selection = Call | Miss;
export const EMPTY_PARAMS: Params = Object.freeze(Object.create(null) as Record<string, string>);
const node = (): Node => ({ static: new Map() });
const strip = (path: string) => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
const decode = (segment: string) => (segment.includes("%") ? decodeURIComponent(segment) : segment);
const escaped = (segment: string) => segment.replaceAll("%", "%25").replaceAll("/", "%2F");
const normalizePath = (path: string): string => {
  // Match the pathname a standard Request exposes, including encoded dots.
  // Ordinary paths avoid constructing a URL.
  if (path.includes("\\") || path.includes("/.") || (path.includes("%") && /%2e/i.test(path))) {
    try {
      return new URL("http://kernel.invalid" + path).pathname;
    } catch {
      throw new URIError("invalid request path");
    }
  }
  return path;
};
export const canonical = (path: string): string =>
  path.includes("%")
    ? path
        .split("/")
        .map((x) => escaped(decode(x)))
        .join("/")
    : path;
export const pathOf = (url: string): string => {
  let start = 0;
  if (!url.startsWith("/")) {
    if (url.includes("\\")) {
      try {
        return strip(new URL(url).pathname);
      } catch {
        throw new URIError("invalid absolute target");
      }
    }
    const scheme = url.indexOf("://");
    if (scheme === -1) return url;
    const authority = scheme + 3;
    start = url.indexOf("/", authority);
    const query = url.indexOf("?", authority),
      hash = url.indexOf("#", authority);
    if (start === -1 || (query !== -1 && query < start) || (hash !== -1 && hash < start))
      return "/";
  }
  let end = url.length;
  const query = url.indexOf("?", start),
    hash = url.indexOf("#", start);
  if (query !== -1) end = query;
  if (hash !== -1 && hash < end) end = hash;
  return strip(normalizePath(url.slice(start, end) || "/"));
};
const pattern = (path: string): Segment[] => {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#"))
    throw new TypeError("route must be a path without query or fragment");
  const normalized = strip(path);
  if (normalized === "/") return [];
  const names = new Set<string>();
  return normalized
    .slice(1)
    .split("/")
    .map((part, index, all) => {
      if (!part) throw new TypeError("empty route segment");
      if (part.startsWith(":")) {
        const name = part.slice(1);
        if (!/^[A-Za-z_$][\w$]*$/.test(name) || names.has(name))
          throw new TypeError("invalid or duplicate parameter");
        names.add(name);
        return { kind: "param", value: name };
      }
      if (part.startsWith("*")) {
        const name = part.slice(1) || "wildcard";
        if (index !== all.length - 1 || !/^[A-Za-z_$][\w$]*$/.test(name) || names.has(name))
          throw new TypeError("invalid wildcard");
        names.add(name);
        return { kind: "wild", value: name };
      }
      if (part.includes("*") || part.includes(":")) throw new TypeError("unsupported route syntax");
      return { kind: "static", value: decode(part) };
    });
};
interface Table {
  root: Node;
  exact: Map<string, Call>;
}
const capture = (plan: Plan, values: string[], path: string): Call => {
  const params: Record<string, string> = Object.create(null);
  for (let i = 0; i < plan.names.length; i++) params[plan.names[i]!] = values[i]!;
  return { kind: "route", endpoint: plan.endpoint, params, path };
};
const walk = (
  current: Node,
  parts: string[],
  index: number,
  values: string[],
  path: string,
): Call | null => {
  if (index === parts.length) {
    if (current.plan) return capture(current.plan, values, path);
    if (current.wild?.plan) return capture(current.wild.plan, [...values, ""], path);
    return null;
  }
  const part = parts[index]!;
  const fixed = current.static.get(part);
  if (fixed) {
    const found = walk(fixed, parts, index + 1, values, path);
    if (found) return found;
  }
  if (current.param && part.length) {
    values.push(part);
    const found = walk(current.param, parts, index + 1, values, path);
    values.pop();
    if (found) return found;
  }
  if (current.wild?.plan)
    return capture(current.wild.plan, [...values, parts.slice(index).join("/")], path);
  return null;
};
const find = (table: Table | undefined, path: string): Call | null => {
  if (!table) return null;
  const exact = table.exact.get(path);
  if (exact) return exact;
  const parts =
    path === "/"
      ? []
      : path
          .slice(1)
          .split("/")
          .map((x) => decode(x));
  return walk(table.root, parts, 0, [], path);
};
/** Method-aware, sealed lookup. Mutable maps remain private to this closure. */
export const compileRoutes = (
  definitions: readonly Definition[],
): ((method: string, url: string) => Selection) => {
  const tables = new Map<string, Table>();
  for (const definition of definitions) {
    const segments = pattern(definition.path);
    let table = tables.get(definition.method);
    if (!table) {
      table = { root: node(), exact: new Map() };
      tables.set(definition.method, table);
    }
    let current = table.root;
    const names: string[] = [];
    for (const segment of segments) {
      if (segment.kind === "static") {
        let next = current.static.get(segment.value);
        if (!next) {
          next = node();
          current.static.set(segment.value, next);
        }
        current = next;
      } else {
        names.push(segment.value);
        if (segment.kind === "param") current = current.param ??= node();
        else current = current.wild ??= node();
      }
    }
    if (current.plan)
      throw new TypeError(`ambiguous duplicate route: ${definition.method} ${definition.path}`);
    const endpoint = Object.freeze({ ...definition.endpoint }) as Endpoint;
    current.plan = Object.freeze({ endpoint, names: Object.freeze(names) });
    if (!names.length) {
      const path = "/" + segments.map((s) => escaped(s.value)).join("/");
      table.exact.set(path, Object.freeze({ kind: "route", endpoint, params: EMPTY_PARAMS, path }));
    }
  }
  return (rawMethod, url) => {
    const method = rawMethod.toUpperCase(),
      path = canonical(pathOf(url));
    if (!path.startsWith("/")) throw new URIError("unsupported request target");
    let found = find(tables.get(method), path);
    if (!found && method === "HEAD") found = find(tables.get("GET"), path);
    if (!found) found = find(tables.get("ALL"), path);
    if (found) return found;
    const allow: string[] = [];
    for (const [verb, table] of tables) if (verb !== "ALL" && find(table, path)) allow.push(verb);
    if (allow.includes("GET") && !allow.includes("HEAD")) allow.push("HEAD");
    if (allow.length && !allow.includes("OPTIONS")) allow.push("OPTIONS");
    return {
      kind: "miss",
      path,
      reply: allow.length
        ? new Reply(
            method === "OPTIONS" ? null : "Method Not Allowed",
            method === "OPTIONS" ? 204 : 405,
            { allow: allow.toSorted().join(", ") },
          )
        : new Reply("Not Found", 404),
    };
  };
};
