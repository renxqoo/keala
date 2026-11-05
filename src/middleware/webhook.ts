import { limitBodyStream } from "srvx/body-limit";
import { createError } from "../http/errors.ts";
import { readAllLimited } from "../utils/streams.ts";
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
  maxBodySize?: number;
}

/** An HMAC-SHA256 MAC is exactly 32 bytes — anything else is malformed. */
const MAC_BYTES = 32;
const DEFAULT_TOLERANCE = 300;
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024;
/** Header-value cap: parsing an unbounded attacker-controlled string is a DoS. */
const MAX_SIGNATURE_LENGTH = 512;
const HEX_RE = /^[0-9a-f]+$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DIGITS_RE = /^[0-9]+$/;
const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";

const encoder = new TextEncoder();
const bodyTooLarge = () =>
  createError(413, "webhook body exceeds the byte limit", { expose: true });

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

interface ParsedSignature {
  signatures: string[];
  timestamp: string | null;
  prefix: string;
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
  return { signatures, timestamp, prefix: `${timestamp}.` };
};

const parseGithub = (value: string): ParsedSignature | null => {
  if (!value.startsWith("sha256=")) return null;
  return { signatures: [value.slice("sha256=".length)], timestamp: null, prefix: "" };
};

const parseSlack = (value: string, timestampHeader: string): ParsedSignature | null => {
  let signature = value.startsWith("v0=") ? value.slice(3) : value;
  let timestamp = timestampHeader.trim();
  const comma = signature.indexOf(","); // base64 never contains a comma
  if (comma !== -1) {
    // Timestamp precedence: the dedicated x-slack-request-timestamp header
    // wins; the comma-embedded `v0=<ts>,<mac>` form is the FALLBACK, read
    // only when the header is absent/empty. When both are present they must
    // agree — the MAC covers whichever timestamp was chosen.
    if (timestamp.length === 0) timestamp = signature.slice(0, comma).trim();
    signature = signature.slice(comma + 1).trim();
  }
  if (timestamp.length === 0) return null;
  return { signatures: [signature], timestamp, prefix: `v0:${timestamp}:` };
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
      return { signatures: [value], timestamp: null, prefix: "" };
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
  const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  if (!Number.isSafeInteger(maxBodySize) || maxBodySize < 0) {
    throw new TypeError("webhook({ maxBodySize }) requires a non-negative safe integer of bytes");
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
  const sign = async (payload: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign("HMAC", await key, payload));

  return async (c, next) => {
    const headerValue = c.header(normalizedHeader).trim();
    if (headerValue.length === 0) {
      return c.text("Missing webhook signature", 400);
    }
    const parsed = parseSignature(format, headerValue, c.header(SLACK_TIMESTAMP_HEADER));
    if (parsed === null) {
      return c.text("Malformed webhook signature", 400);
    }
    const signatures = parsed.signatures.map(macBytes).filter((value) => value !== null);
    if (signatures.length === 0) return c.text("Malformed webhook signature", 400);
    if (parsed.timestamp !== null) {
      const seconds = epochSeconds(parsed.timestamp);
      if (seconds === null) return c.text("Malformed webhook timestamp", 400);
      if (Math.abs(Math.floor(Date.now() / 1000) - seconds) > tolerance) {
        return c.text("Stale webhook timestamp", 400);
      }
    }
    const declared = c.reqLength;
    if (declared !== undefined && declared > maxBodySize) throw bodyTooLarge();
    const raw = c.raw;
    const copy = raw.clone();
    let body: Uint8Array;
    try {
      body =
        copy.body === null
          ? new Uint8Array(0)
          : await readAllLimited(
              limitBodyStream(copy.body, maxBodySize, { createError: bodyTooLarge }),
              maxBodySize,
              bodyTooLarge,
            );
    } catch (error) {
      void raw.body?.cancel(error).catch(() => undefined);
      throw error;
    }
    const prefix = encoder.encode(parsed.prefix);
    const payload = new Uint8Array(prefix.byteLength + body.byteLength);
    payload.set(prefix);
    payload.set(body, prefix.byteLength);
    const expected = await sign(payload);
    if (!signatures.some((candidate) => timingSafeEqual(expected, candidate))) {
      void raw.body?.cancel().catch(() => undefined);
      return c.text("Invalid webhook signature", 401);
    }
    await next();
  };
};
