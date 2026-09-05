/**
 * Ambient declaration for the negotiator oracle used ONLY as a live
 * reference by regression-sweep's accepts tests (negotiator ships no types;
 * no @types/* is shipped or required at runtime). Split out of the retired
 * agent-r6-diff-koa.deps.d.ts in U1 (koa parity retirement).
 */
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
