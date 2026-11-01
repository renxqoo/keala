import {
  compileRoutes,
  pathOf,
  type Definition,
  type Selection,
  type TextHandler,
  type FetchHandler,
} from "./router.ts";
import { compileRoutesRegExp } from "./router-regexp.ts";
import {
  ERROR_REPLY,
  PATH_ERROR,
  isPromise,
  toResponse,
  type Result,
  type Value,
  type WebResponse,
} from "./reply.ts";
export { Reply, json } from "./reply.ts";
export type { Params, Result } from "./reply.ts";
export type Middleware = (request: Request, next: () => PromiseLike<WebResponse>) => Result;
interface Layer {
  prefix: string;
  run: Middleware;
}
export interface Executable {
  select(method: string, url: string): Selection;
  needsRequest(selection: Selection): boolean;
  invoke(selection: Selection, request?: Request): Result;
  fail(error: unknown): Result;
  fetch(request: Request): Response | Promise<Response>;
}
const applies = (prefix: string, path: string) =>
  prefix === "/" || path === prefix || path.startsWith(prefix + "/");
function safeResponse(value: Value, head: boolean): Response {
  try {
    return toResponse(value, head);
  } catch {
    return toResponse(ERROR_REPLY, head);
  }
}
const runEndpoint = (selection: Selection, request?: Request): Result => {
  if (selection.kind === "miss") return selection.reply;
  if (selection.endpoint.kind === "fetch") {
    if (!request) throw new TypeError("Fetch endpoint requires Request capability");
    return selection.endpoint.handler(request, selection.params);
  }
  const result = selection.endpoint.handler(selection.params);
  if (typeof result === "string") return result;
  if (isPromise(result))
    return Promise.resolve(result).then((value) => {
      if (typeof value !== "string") throw new TypeError("text handler must return a string");
      return value;
    });
  throw new TypeError("text handler must return a string");
};
export class Kernel {
  #router: "trie" | "regexp";
  #definitions: Definition[] = [];
  #layers: Layer[] = [];
  #error: ((error: unknown) => Result) | undefined;
  #built: Executable | undefined;
  constructor(options: { router?: "trie" | "regexp" } = {}) {
    this.#router = options.router ?? "trie";
    if (this.#router !== "trie" && this.#router !== "regexp")
      throw new TypeError("unknown router strategy");
  }
  #assertOpen(): void {
    if (this.#built) throw new Error("kernel is sealed; build a new snapshot to change routes");
  }
  text(method: string, path: string, handler: TextHandler): this {
    this.#assertOpen();
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    this.#definitions.push({
      method: this.#method(method),
      path,
      endpoint: { kind: "text", handler },
    });
    return this;
  }
  route(method: string, path: string, handler: FetchHandler): this {
    this.#assertOpen();
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    this.#definitions.push({
      method: this.#method(method),
      path,
      endpoint: { kind: "fetch", handler },
    });
    return this;
  }
  #method(method: string): string {
    const value = method.toUpperCase();
    if (!/^[A-Z]+$/.test(value)) throw new TypeError("invalid HTTP method");
    return value;
  }
  use(prefix: string, middleware: Middleware): this {
    this.#assertOpen();
    if (typeof middleware !== "function") throw new TypeError("middleware must be a function");
    if (
      !prefix.startsWith("/") ||
      prefix.includes("%") ||
      prefix.includes("?") ||
      prefix.includes("#") ||
      prefix.includes("*") ||
      prefix.includes(":")
    )
      throw new TypeError("middleware prefix must be a literal path");
    this.#layers.push({
      prefix: prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix,
      run: middleware,
    });
    return this;
  }
  onError(handler: (error: unknown) => Result): this {
    this.#assertOpen();
    if (typeof handler !== "function") throw new TypeError("error handler must be a function");
    this.#error = handler;
    return this;
  }
  build(): Executable {
    if (this.#built) return this.#built;
    const lookup =
      this.#router === "regexp"
        ? compileRoutesRegExp(this.#definitions)
        : compileRoutes(this.#definitions);
    const select = (method: string, url: string): Selection => {
      try {
        return lookup(method, url);
      } catch (error) {
        if (error instanceof URIError) {
          let path = "/";
          try {
            path = pathOf(url);
          } catch {
            /* Invalid URL cannot select an endpoint. */
          }
          return { kind: "miss", path, reply: PATH_ERROR };
        }
        throw error;
      }
    };
    const layers = this.#layers.slice();
    const errorHandler = this.#error;
    const fail = (error: unknown): Result => {
      if (!errorHandler) return ERROR_REPLY;
      try {
        const result = errorHandler(error);
        return isPromise(result) ? Promise.resolve(result).catch(() => ERROR_REPLY) : result;
      } catch {
        return ERROR_REPLY;
      }
    };
    type Chain = (request: Request, selection: Selection) => Promise<Response>;
    let chain: Chain = async (request, selection) =>
      toResponse(await runEndpoint(selection, request));
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]!,
        downstream = chain;
      chain = async (request, selection) => {
        if (!applies(layer.prefix, selection.path)) return downstream(request, selection);
        let advanced = false,
          observed = false;
        let pending: Promise<Response> | undefined;
        let returned: Response | undefined;
        const next = () => {
          if (advanced) throw new Error("next() called twice");
          advanced = true;
          const branch = (pending = downstream(request, selection));
          void branch.catch(() => undefined);
          return {
            // eslint-disable-next-line unicorn/no-thenable -- observe assimilation without starting another branch
            then: <T = Response, U = never>(
              ok?: ((value: Response) => T | PromiseLike<T>) | null,
              bad?: ((reason: unknown) => U | PromiseLike<U>) | null,
            ) => {
              observed = true;
              return branch.then(ok, bad);
            },
          };
        };
        try {
          const result = await layer.run(request, next);
          if (advanced && !observed) throw new Error("next() must be awaited or returned");
          return (returned = toResponse(result));
        } finally {
          // A floated branch may still be reading a body; join it before release.
          if (pending) {
            const abandoned = await pending.catch(() => undefined);
            try {
              if (
                abandoned &&
                abandoned !== returned &&
                abandoned.body !== returned?.body &&
                abandoned.body &&
                !abandoned.body.locked
              )
                // A cloned/tee branch may wait for its sibling. Do not join cancellation.
                void abandoned.body.cancel().catch(() => undefined);
            } catch {
              /* Cleanup must preserve the original middleware result/error. */
            }
          }
        }
      };
    }
    const needsRequest =
      layers.length === 0
        ? (selection: Selection) =>
            selection.kind === "route" && selection.endpoint.kind === "fetch"
        : (selection: Selection) =>
            (selection.kind === "route" && selection.endpoint.kind === "fetch") ||
            layers.some((layer) => applies(layer.prefix, selection.path));
    const invoke =
      layers.length === 0
        ? runEndpoint
        : (selection: Selection, request?: Request): Result => {
            if (!layers.some((layer) => applies(layer.prefix, selection.path)))
              return runEndpoint(selection, request);
            if (!request) throw new TypeError("middleware requires Request capability");
            return chain(request, selection);
          };
    const fetch = (request: Request): Response | Promise<Response> => {
      const head = request.method === "HEAD";
      try {
        const result = invoke(select(request.method, request.url), request);
        return isPromise(result)
          ? Promise.resolve(result)
              .then((value) => toResponse(value, head))
              .catch((error) =>
                Promise.resolve(fail(error)).then((value) => safeResponse(value, head)),
              )
          : toResponse(result, head);
      } catch (error) {
        const result = fail(error);
        return isPromise(result)
          ? Promise.resolve(result).then((value) => safeResponse(value, head))
          : safeResponse(result, head);
      }
    };
    this.#built = Object.freeze({ select, needsRequest, invoke, fail, fetch });
    return this.#built;
  }
  fetch = (request: Request): Response | Promise<Response> => this.build().fetch(request);
}
