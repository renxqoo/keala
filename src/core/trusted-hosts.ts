/**
 * Host whitelist (DESIGN §7.2, Host-poisoning defense): a compiled matcher
 * for `trustedHosts`. Exact names and single-label `*.suffix` wildcards,
 * lowercased, port-insensitive; `null` (unset/empty list) admits everything.
 * Extracted from app.ts for the 500-line budget.
 */

import { sourceHeader, sourceUrl } from "./request-source.ts";
import type { RequestSource } from "./request-source.ts";

/** Lowercased Host authority without its port (bracketed IPv6 aware). */
const stripHostPort = (host: string): string => {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1) || host;
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
};

/** URL authority (host[:port]) for requests without a Host header. */
const urlAuthority = (url: string): string => {
  const scheme = url.indexOf("://");
  if (scheme === -1) return "";
  let rest = url.slice(scheme + 3);
  const slash = rest.indexOf("/");
  const at = rest.indexOf("@");
  if (at !== -1 && (slash === -1 || at < slash)) rest = rest.slice(at + 1);
  const end = rest.search(/[/?#]/);
  return end === -1 ? rest : rest.slice(0, end);
};

export type TrustedHostMatcher = ((request: RequestSource) => boolean) | null;

/** Compile the option into a per-request predicate (null = admit all). */
export const compileTrustedHosts = (trustedHosts: string[] | undefined): TrustedHostMatcher => {
  if (trustedHosts === undefined || trustedHosts.length === 0) return null;
  const entries = trustedHosts.map((host) => host.toLowerCase());
  return (request: RequestSource): boolean => {
    // A live HTTP request always carries Host; an in-process Request does
    // not materialize it, so the URL authority is the fallback source.
    const header = sourceHeader(request, "host");
    const authority = stripHostPort((header ?? urlAuthority(sourceUrl(request))).toLowerCase());
    // Under proxy trust, c.host/origin/back() prefer X-Forwarded-Host — the
    // whitelist must admit THAT authority too, or a pass-through proxy
    // re-enables exactly the poisoning trustedHosts exists to stop. A
    // forwarded CHAIN admits on its first (client-supplied) entry, matching
    // the c.host read; both this and the direct Host must pass.
    const forwarded = sourceHeader(request, "x-forwarded-host");
    if (forwarded !== null && forwarded !== "") {
      const first = stripHostPort(forwarded.split(",")[0]?.trim().toLowerCase() ?? "");
      if (first.length > 0 && !entries.some((entry) => matchesEntry(entry, first))) {
        return false;
      }
    }
    return entries.some((entry) => matchesEntry(entry, authority));
  };
};

/** Single-label `*.suffix` wildcards and exact names (both lowercased). */
const matchesEntry = (entry: string, authority: string): boolean => {
  if (entry.startsWith("*.")) {
    // Single label only: `a.subs.example.com` matches `*.subs.example.com`
    // but `deep.a.subs.example.com` must not.
    return (
      authority.endsWith(entry.slice(1)) &&
      authority.length > entry.length - 1 &&
      !authority.slice(0, -entry.length + 1).includes(".")
    );
  }
  return entry === authority;
};

/** The refusal served before any routing work on a forged Host. */
export const hostRefused = (): Response =>
  new Response("Forbidden Host", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
