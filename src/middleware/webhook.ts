/**
 * webhook — HMAC-SHA256 signature verification for provider webhooks (N3).
 *
 * Four wire formats, one constant-time comparison at the bottom:
 * - stripe: `t=<unix-seconds>,v1=<mac>` — MAC over `<t>.<body>` (Stripe
 *   ships hex v1; base64 is accepted too), multiple `v1` entries rotate keys
 * - github: `sha256=<hex-mac>` — MAC over the raw body
 * - slack: `v0=<mac>` + `x-slack-request-timestamp` (the `v0=<ts>,<mac>`
 *   comma-embedded form is also accepted) — MAC over `v0:<ts>:<body>`
 * - raw: the configured header value IS the MAC (hex or base64)
 *
 * The three traps this exists to defuse:
 * 1. timing attacks — the received MAC is compared with `timingSafeEqual`
 *    (MAC vs MAC, never plaintext), imported from the auth tier
 * 2. replay attacks — stripe/slack timestamps must land inside the
 *    `tolerance` window (default 300s, future timestamps included);
 *    TODO(replay-cache): an optional seen-signature store would tighten the
 *    window to once-only delivery — the timestamp bound is the 0.x contract
 * 3. body consumption — the MAC runs over `c.raw.clone().text()`, so the
 *    original body stays readable for the downstream handler
 *
 * Statuses: missing/empty/malformed signature or a stale timestamp → 400
 * (the request is not verifiable), a well-formed signature that does not
 * verify → 401.
 */

import { timingSafeEqual } from "./auth.ts";
import type { RouteHandler } from "../router/router.ts";

/** The four supported signature-header grammars. */
export type WebhookFormat = "stripe" | "github" | "slack" | "raw";

export interface WebhookOptions {
  /** Shared HMAC secret (the provider's signing secret). */
  secret: string;
  /** Name of the header carrying the signature, e.g. "stripe-signature". */
  header: string;
  /** Signature grammar. */
  format: WebhookFormat;
  /**
   * Timestamp freshness window in seconds (stripe/slack only). Default 300.
   */
  tolerance?: number;
}

/** An HMAC-SHA256 MAC is exactly 32 bytes — anything else is malformed. */
const MAC_BYTES = 32;
const DEFAULT_TOLERANCE = 300;
/** Header-value cap: parsing an unbounded attacker-controlled string is a DoS. */
const MAX_SIGNATURE_LENGTH = 512;
const HEX_RE = /^[0-9a-f]+$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DIGITS_RE = /^[0-9]+$/;
const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";

const encoder = new TextEncoder();

const hexBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/**
 * Decode a signature to MAC bytes. Hex first (the encoding Stripe and Slack
 * actually put on the wire), then padded-or-unpadded base64. A value that
 * decodes under neither grammar — or not to exactly 32 bytes — is malformed.
 */
const macBytes = (value: string): Uint8Array | null => {
  if (value.length === 0 || value.length > MAX_SIGNATURE_LENGTH) return null;
  if (HEX_RE.test(value) && value.length % 2 === 0) {
    const bytes = hexBytes(value);
    return bytes.length === MAC_BYTES ? bytes : null;
  }
  if (BASE64_RE.test(value)) {
    const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
    const bytes = new Uint8Array(Buffer.from(padded, "base64"));
    return bytes.length === MAC_BYTES ? bytes : null;
  }
  return null;
};

/** Digits-only epoch seconds (≤15 digits keeps Number exact). */
const epochSeconds = (value: string): number | null => {
  const trimmed = value.trim();
  if (!DIGITS_RE.test(trimmed) || trimmed.length > 15) return null;
  return Number(trimmed);
};

/** A parsed header: the MAC input (as a function of the body) and its timestamp. */
interface ParsedSignature {
  signatures: string[];
  timestamp: string | null;
  input: (body: string) => string;
}

const parseStripe = (value: string): ParsedSignature | null => {
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const element of value.split(",")) {
    const eq = element.indexOf("=");
    if (eq <= 0) return null;
    const key = element.slice(0, eq).trim();
    const mac = element.slice(eq + 1).trim();
    if (key === "t") timestamp = mac;
    else if (key === "v1") signatures.push(mac);
    // Unknown keys (future Stripe schemes) are ignored, not fatal.
  }
  if (timestamp === null || timestamp.length === 0 || signatures.length === 0) return null;
  return { signatures, timestamp, input: (body) => `${timestamp}.${body}` };
};

const parseGithub = (value: string): ParsedSignature | null => {
  if (!value.startsWith("sha256=")) return null;
  return { signatures: [value.slice("sha256=".length)], timestamp: null, input: (body) => body };
};

const parseSlack = (value: string, timestampHeader: string): ParsedSignature | null => {
  let signature = value.startsWith("v0=") ? value.slice(3) : value;
  let timestamp = timestampHeader.trim();
  const comma = signature.indexOf(","); // base64 never contains a comma
  if (comma !== -1) {
    if (timestamp.length === 0) timestamp = signature.slice(0, comma).trim();
    signature = signature.slice(comma + 1).trim();
  }
  if (timestamp.length === 0) return null;
  return { signatures: [signature], timestamp, input: (body) => `v0:${timestamp}:${body}` };
};

const parseSignature = (
  format: WebhookFormat,
  value: string,
  slackTs: string,
): ParsedSignature | null => {
  switch (format) {
    case "stripe":
      return parseStripe(value);
    case "github":
      return parseGithub(value);
    case "slack":
      return parseSlack(value, slackTs);
    case "raw":
      return { signatures: [value], timestamp: null, input: (body) => body };
  }
};

export const webhook = (options: WebhookOptions): RouteHandler => {
  const secret = options?.secret;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new TypeError("webhook({ secret }) requires a non-empty signing secret");
  }
  const headerName = options?.header;
  if (typeof headerName !== "string" || headerName.trim().length === 0) {
    throw new TypeError("webhook({ header }) requires the signature header name");
  }
  const format = options?.format;
  if (format !== "stripe" && format !== "github" && format !== "slack" && format !== "raw") {
    throw new TypeError('webhook({ format }) must be "stripe" | "github" | "slack" | "raw"');
  }
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new TypeError("webhook({ tolerance }) must be a positive number of seconds");
  }
  const normalizedHeader = headerName.trim().toLowerCase();
  // The HMAC key imports once at setup; requests await the settled promise.
  const key = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sign = async (payload: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign("HMAC", await key, encoder.encode(payload)));

  return async (c, next) => {
    const headerValue = c.header(normalizedHeader).trim();
    if (headerValue.length === 0) {
      return c.text("Missing webhook signature", 400);
    }
    const parsed = parseSignature(format, headerValue, c.header(SLACK_TIMESTAMP_HEADER));
    if (parsed === null) {
      return c.text("Malformed webhook signature", 400);
    }
    // clone(): the MAC reads a copy — the original body stays unread for the
    // downstream handler (the body-preservation contract).
    const body = await c.raw.clone().text();
    const expected = await sign(parsed.input(body));
    // Decode first, compare second: a decodable-but-wrong MAC is a forgery
    // (401); a value that cannot even decode is a malformed header (400).
    let decoded: Uint8Array | null = null;
    let verified = false;
    for (const signature of parsed.signatures) {
      const candidate = macBytes(signature);
      if (candidate === null) continue;
      decoded = candidate;
      if (timingSafeEqual(expected, candidate)) {
        verified = true;
        break;
      }
    }
    if (decoded === null) return c.text("Malformed webhook signature", 400);
    if (!verified) return c.text("Invalid webhook signature", 401);
    if (parsed.timestamp !== null) {
      const seconds = epochSeconds(parsed.timestamp);
      if (seconds === null) return c.text("Malformed webhook timestamp", 400);
      // Both directions: a far-future timestamp is as untrustworthy as a stale
      // one (clock-skew forgeries), and the window also bounds replay.
      if (Math.abs(Math.floor(Date.now() / 1000) - seconds) > tolerance) {
        return c.text("Stale webhook timestamp", 400);
      }
    }
    await next();
  };
};
