/**
 * Ambient declarations for the differential-audit reference packages. These
 * are devDependencies used ONLY as live oracles (agent-r6-diff-koa.test.ts
 * compares keala's output against them); no @types/* packages are shipped
 * or required at runtime.
 */
declare module "koa" {
  interface KoaInstance {
    silent: boolean;
    use(mw: (ctx: KoaContext, next: () => Promise<void>) => unknown): unknown;
    callback(): (req: unknown, res: unknown) => Promise<void>;
  }
  interface KoaContext {
    body: unknown;
    status: number;
    message: string;
    url: string;
    headers: Record<string, string | undefined>;
    set(field: string, value: string): void;
    redirect(url: string): void;
    attachment(filename: string): void;
    is(types: string[]): string | false | null;
    type: string;
  }
  const Koa: new (options?: { env?: string }) => KoaInstance;
  export default Koa;
}
declare module "@koa/router" {
  import type { KoaContext } from "koa";
  export class Router {
    get(path: string, mw: (ctx: KoaContext, next: () => Promise<void>) => unknown): void;
    post(path: string, mw: (ctx: KoaContext, next: () => Promise<void>) => unknown): void;
    routes(): (ctx: KoaContext, next: () => Promise<void>) => unknown;
    allowedMethods(): (ctx: KoaContext, next: () => Promise<void>) => unknown;
  }
}
declare module "content-disposition" {
  const contentDisposition: (
    filename: string,
    options?: { fallback?: string | false; type?: string },
  ) => string;
  export default contentDisposition;
}
declare module "encodeurl" {
  const encodeUrl: (url: string) => string;
  export default encodeUrl;
}
declare module "escape-html" {
  const escapeHtml: (value: string) => string;
  export default escapeHtml;
}
declare module "accepts" {
  interface Accepts {
    type(...provided: string[]): string | false;
    encodings(...provided: string[]): string | false;
    languages(...provided: string[]): string | false;
  }
  const accepts: (req: unknown) => Accepts;
  export default accepts;
}
declare module "type-is" {
  const typeis: (req: unknown, types?: string[]) => string | false | null;
  export default typeis;
}
declare module "cookies" {
  class Cookies {
    constructor(req: unknown, res: unknown, options?: { keys?: string[] });
    get(name: string, options?: { signed?: boolean }): string | undefined;
  }
  export = Cookies;
}
declare module "negotiator" {
  class Negotiator {
    constructor(headers: unknown);
    mediaType(provided?: string[]): string | undefined;
    mediaTypes(provided?: string[]): string[];
    encoding(provided?: string[]): string | undefined;
    encodings(provided?: string[]): string[];
    language(provided?: string[]): string | undefined;
    languages(provided?: string[]): string[];
    charset(provided?: string[]): string | undefined;
    charsets(provided?: string[]): string[];
  }
  export = Negotiator;
}
