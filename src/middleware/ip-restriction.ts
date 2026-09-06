/**
 * ipRestriction — CIDR/IP allow+deny gate for client addresses (N4).
 *
 * Rules are plain strings: a bare IP (`192.168.1.100`, `::1`) is an exact
 * match, `ip/prefix` matches the network (`10.0.0.0/8`, `2001:db8::/32`),
 * and a /0 prefix is family-wide (`0.0.0.0/0` = every IPv4 address).
 *
 * Evaluation order: deny first (a hit refuses with 403), then allow (a hit
 * passes; an allow list that does NOT contain the address refuses). Deny
 * always wins — `allow: ["0.0.0.0/0"], deny: [...]` is the "everything but"
 * shape. A deny-only configuration passes everything not denied.
 *
 * The address comes from `c.ip` (the trusted-proxy chain when the app runs
 * `proxy: true`). IPv4 and IPv6 compare strictly within their own family —
 * no ::ffff:0:0/96 interconversion, so an IPv4 rule never admits an
 * IPv6-mapped peer. Unparseable rules are loud setup TypeErrors; an
 * unresolvable client address fails CLOSED (403) — a gate that opens when it
 * cannot see the address is not a gate.
 *
 * Zero dependencies: addresses parse with pure arithmetic/bit masks
 * (`ipToInt` for IPv4, a BigInt for the 128 IPv6 bits), never inet_pton.
 */

import { statusMessage } from "../http/status.ts";
import type { RouteHandler } from "../router/router.ts";

export interface IpRestrictionOptions {
  /** Addresses/CIDRs that may pass (an allow list not containing the address refuses it). */
  allow?: readonly string[];
  /** Addresses/CIDRs always refused, checked before `allow`. */
  deny?: readonly string[];
}

/** One compiled rule: family + masked network. A peer matches when its bits under `mask` equal `network`. */
interface CompiledRule {
  v4: boolean;
  network: bigint;
  mask: bigint;
}

const IPV4_OCTET_RE = /^\d{1,3}$/;
const IPV6_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;
const PREFIX_RE = /^\d{1,3}$/;

/** `10.0.0.1` → 0x0A000001n (BigInt, so both families share one compare). */
export const ipToInt = (ip: string): bigint | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!IPV4_OCTET_RE.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
};

/**
 * `2001:db8::1` → 128 BigInt bits. Handles `::` compression (at most one),
 * 1-4 hex-digit groups, and an embedded dotted-IPv4 tail (`::ffff:1.2.3.4`).
 */
const ipv6ToBits = (ip: string): bigint | null => {
  let text = ip;
  if (text.includes("%")) return null; // a zone id (fe80::1%eth0) never matches
  if (text.includes(".")) {
    // Embedded IPv4 tail: rewrite the last group pair as two hex groups.
    const lastColon = text.lastIndexOf(":");
    const tail = ipToInt(text.slice(lastColon + 1));
    if (tail === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const headText = halves[0] ?? "";
  const tailText = halves[1] ?? "";
  const head = headText === "" ? [] : headText.split(":");
  const tail = halves.length === 2 && tailText !== "" ? tailText.split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 0 : head.length !== 8) return null;
  const groups =
    halves.length === 2 ? [...head, ...Array<string>(missing).fill("0"), ...tail] : head;
  let bits = 0n;
  for (const group of groups) {
    if (!IPV6_GROUP_RE.test(group)) return null;
    bits = (bits << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return bits;
};

/** Prefix → contiguous high-bit mask (`8` over 32 → 0xFFFFFF00n). */
const prefixMask = (prefix: number, bits: number): bigint =>
  prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);

/** Compile one rule string; invalid rules are a setup TypeError, never a silent no-match. */
const compileRule = (rule: string): CompiledRule => {
  if (typeof rule !== "string" || rule.trim().length === 0) {
    throw new TypeError(`ipRestriction: invalid rule ${JSON.stringify(rule)}`);
  }
  const [address = "", prefixText] = rule.trim().split("/");
  const v4 = !address.includes(":");
  const bits = v4 ? ipToInt(address) : ipv6ToBits(address);
  if (bits === null) {
    throw new TypeError(
      `ipRestriction: invalid rule ${JSON.stringify(rule)} (unparseable address)`,
    );
  }
  const width = v4 ? 32 : 128;
  if (prefixText === undefined) {
    return { v4, network: bits, mask: (1n << BigInt(width)) - 1n };
  }
  if (!PREFIX_RE.test(prefixText)) {
    throw new TypeError(`ipRestriction: invalid rule ${JSON.stringify(rule)} (bad prefix)`);
  }
  const prefix = Number(prefixText);
  if (prefix > width) {
    throw new TypeError(`ipRestriction: invalid rule ${JSON.stringify(rule)} (prefix > /${width})`);
  }
  const mask = prefixMask(prefix, width);
  // Host bits below the mask are dropped: 10.0.0.1/8 means 10.0.0.0/8.
  return { v4, network: bits & mask, mask };
};

const compileRules = (rules: readonly string[] | undefined, name: string): CompiledRule[] => {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) {
    throw new TypeError(`ipRestriction: ${name} must be an array of IP/CIDR strings`);
  }
  return rules.map(compileRule);
};

const parseAddress = (ip: string): { v4: boolean; bits: bigint } | null => {
  if (typeof ip !== "string" || ip.length === 0) return null;
  if (ip.includes(":")) {
    const bits = ipv6ToBits(ip);
    return bits === null ? null : { v4: false, bits };
  }
  const bits = ipToInt(ip);
  return bits === null ? null : { v4: true, bits };
};

const matchesAny = (rules: CompiledRule[], address: { v4: boolean; bits: bigint }): boolean => {
  for (const rule of rules) {
    if (rule.v4 === address.v4 && (address.bits & rule.mask) === rule.network) return true;
  }
  return false;
};

export const ipRestriction = (options: IpRestrictionOptions): RouteHandler => {
  const allow = compileRules(options?.allow, "allow");
  const deny = compileRules(options?.deny, "deny");
  if (allow.length === 0 && deny.length === 0) {
    throw new TypeError("ipRestriction() requires at least one allow or deny rule");
  }
  const forbidden = statusMessage(403) || "403";
  return async (c, next) => {
    const address = parseAddress(c.ip);
    // Fail closed: no readable address → refuse, in every configuration.
    if (address === null) return c.text(forbidden, 403);
    if (matchesAny(deny, address)) return c.text(forbidden, 403);
    if (allow.length === 0 || matchesAny(allow, address)) return next();
    return c.text(forbidden, 403);
  };
};
