/**
 * JWT guard — RFC 7519 claims over RFC 7515 JWS signatures, plus the
 * Bearer request challenge of RFC 6750. Primitives: `signJWT` (issue) and
 * `verifyJWT` (validate, pure). Request guard: `jwt({ secret })` verifies
 * `Authorization: Bearer <token>`, publishes the payload as `c.state.jwt`
 * and rejects everything else with 401 + WWW-Authenticate.
 *
 * Security posture — HS256/384/512 + RS256/384/512 + ES256/384/512 only;
 * `alg: "none"` is structurally unlistable and the token's header alg must
 * be whitelisted. An HMAC shared secret never feeds an RSA/EC import and an
 * asymmetric key never acts as an HMAC secret (algorithm confusion —
 * enforced at setup AND verify time). exp/nbf carry a configurable clock-skew
 * allowance (30s default); iss/aud are checked whenever named. HMAC compares
 * constant-time. A hostile token is an attack surface, not a bug: every
 * failure answers 401, never 500. ES* signatures are the WebCrypto raw r||s
 * form (hono's format), not JWS DER — convert upstream if a DER-only JOSE
 * library must interoperate. Zero dependencies: Web Crypto only, Bun/Node alike.
 */

import type { JsonWebKey, webcrypto } from "node:crypto";
import type { Context } from "../core/context/context.ts";
import type { RouteHandler } from "../router/router.ts";

export type SignatureAlgorithm =
  | "HS256"
  | "HS384"
  | "HS512"
  | "RS256"
  | "RS384"
  | "RS512"
  | "ES256"
  | "ES384"
  | "ES512";

/** JWT claim set — registered claims typed, custom claims via the index. */
export interface JWTPayload {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [claim: string]: unknown;
}

/** HMAC shared secret (bare string), JsonWebKey, or a WebCrypto key. */
export type JWTKey = string | JsonWebKey | CryptoKey;

export interface SignOptions {
  /** Signature algorithm. Default: the key's own, or HS256 for secrets. */
  alg?: SignatureAlgorithm;
  /** Extra JOSE header fields (kid…); `alg`/`typ` stay under our control. */
  header?: Record<string, unknown>;
}

export interface VerifyOptions {
  /** Allowed algorithms — the token's header alg must be listed. Default: the HS family for string secrets, the key's own algorithm for keys. */
  algorithms?: readonly SignatureAlgorithm[];
  /** Expected issuer; validated when provided. */
  iss?: string | RegExp;
  /** Expected audience(s); validated when provided. */
  aud?: string | string[] | RegExp;
  /** exp/nbf clock-skew allowance in seconds. Default 30; 0 is exact. */
  clockTolerance?: number;
}

export interface JWTOptions extends VerifyOptions {
  /** HMAC secret or public key the tokens are signed with. */
  secret: JWTKey;
  /** Protection-space label for WWW-Authenticate challenges. Default "Restricted". */
  realm?: string;
}

const HS_ALGORITHMS: readonly SignatureAlgorithm[] = ["HS256", "HS384", "HS512"];
const SUPPORTED: ReadonlySet<string> = new Set<string>([
  ...HS_ALGORITHMS,
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
]);
const isHmac = (alg: string): boolean => alg.startsWith("HS");
const BITS: ReadonlySet<string> = new Set(["256", "384", "512"]);
const CURVES: Readonly<Record<string, string>> = { ES256: "P-256", ES384: "P-384", ES512: "P-521" };
const ALG_OF_CURVE = new Map<string, SignatureAlgorithm>([
  ["P-256", "ES256"],
  ["P-384", "ES384"],
  ["P-521", "ES512"],
]);
const MAX_TOKEN_BYTES = 8192;
/** Strict base64url: no padding, no stray characters, no empty segments. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** A present-but-non-numeric exp/nbf is a rejection, not a skip. */
const numeric = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const algorithmParams = (
  alg: SignatureAlgorithm,
):
  | webcrypto.HmacImportParams
  | webcrypto.RsaHashedImportParams
  | (webcrypto.EcdsaParams & webcrypto.EcKeyImportParams) => {
  const bits = alg.slice(-3);
  if (!BITS.has(bits)) throw new TypeError(`jwt: unsupported algorithm "${alg}"`);
  const hash = `SHA-${bits}` as webcrypto.AlgorithmIdentifier;
  if (isHmac(alg)) return { name: "HMAC", hash };
  if (alg.startsWith("RS")) return { name: "RSASSA-PKCS1-v1_5", hash };
  return { name: "ECDSA", hash, namedCurve: CURVES[alg] };
};

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const jsonSegment = (value: unknown): string => b64url(encoder.encode(JSON.stringify(value)));

/** Token-side failures; the middleware maps every one of them to a 401. */
const verificationError = (code: string, detail: string): Error =>
  Object.assign(new Error(detail), { code });

const decodeSegment = (segment: string): Uint8Array => {
  // Strict base64url: no padding, no stray characters, no empty segments.
  if (segment.length === 0 || !SEGMENT.test(segment))
    throw verificationError("invalid_token", "token segment is not base64url");
  return new Uint8Array(Buffer.from(segment, "base64url"));
};

const jsonOfSegment = (segment: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeSegment(segment)));
  } catch {
    throw verificationError("invalid_token", "token segment is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw verificationError("invalid_token", "token segment is not a JSON object");
  return parsed as Record<string, unknown>;
};

const tokenSegments = (token: string): string[] => {
  const parts = token.split(".");
  if (
    token.length === 0 ||
    token.length > MAX_TOKEN_BYTES ||
    parts.length !== 3 ||
    parts.some((part) => part.length === 0)
  ) {
    throw verificationError("invalid_token", "token is not three non-empty base64url segments");
  }
  return parts;
};

/** Constant-time byte comparison for the HMAC path (length inequality returns
 * early — signature lengths are public). */
const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

const isCryptoKey = (key: unknown): key is CryptoKey =>
  typeof CryptoKey !== "undefined" && key instanceof CryptoKey;

/** The single algorithm a key itself pins, when it does. */
const algOfKey = (key: JWTKey): SignatureAlgorithm | undefined => {
  if (typeof key === "string") return undefined;
  if (isCryptoKey(key)) {
    const algorithm = key.algorithm as {
      name?: string;
      hash?: string | { name?: string };
      namedCurve?: string;
    };
    // The hash rides the key as "SHA-256" or { name: "SHA-256" } depending on
    // the runtime's normalization — accept both.
    const hashName = typeof algorithm.hash === "string" ? algorithm.hash : algorithm.hash?.name;
    const bits = hashName?.slice(4);
    if (bits !== undefined && BITS.has(bits))
      return `${algorithm.name === "HMAC" ? "HS" : "RS"}${bits}` as SignatureAlgorithm;
    if (algorithm.name === "ECDSA")
      return algorithm.namedCurve === undefined
        ? undefined
        : ALG_OF_CURVE.get(algorithm.namedCurve);
    return undefined;
  }
  if (typeof key.alg === "string" && SUPPORTED.has(key.alg)) return key.alg as SignatureAlgorithm;
  if (key.kty === "EC" && typeof key.crv === "string") return ALG_OF_CURVE.get(key.crv);
  return undefined;
};

/** True when the key can only ever be an HMAC shared secret (a bare string always is one). */
const isSymmetricKey = (key: JWTKey): boolean =>
  typeof key === "string" || (isCryptoKey(key) ? key.type === "secret" : key.kty === "oct");

/** Strip a private JWK down to its public members for verification imports. */
const publicJwkOf = (jwk: JsonWebKey): JsonWebKey => ({
  kty: jwk.kty,
  alg: jwk.alg,
  e: jwk.e,
  n: jwk.n,
  crv: jwk.crv,
  x: jwk.x,
  y: jwk.y,
});

const signingKey = async (key: JWTKey, alg: SignatureAlgorithm): Promise<CryptoKey> => {
  const params = algorithmParams(alg);
  if (isCryptoKey(key)) {
    if (key.type === "private" || key.type === "secret") return key;
    throw new TypeError(`signJWT: a ${key.type} key cannot sign — pass the private key`);
  }
  if (typeof key === "object") return crypto.subtle.importKey("jwk", key, params, false, ["sign"]);
  if (isHmac(alg))
    return crypto.subtle.importKey("raw", encoder.encode(key), params, false, ["sign"]);
  throw new TypeError(
    `signJWT: ${alg} needs a private key — a shared secret only signs HS* tokens`,
  );
};

const verifyingKey = async (key: JWTKey, alg: SignatureAlgorithm): Promise<CryptoKey> => {
  const params = algorithmParams(alg);
  // A private key verifies through its public members only.
  const jwk = async (source: CryptoKey | JsonWebKey): Promise<CryptoKey> => {
    const material = isCryptoKey(source)
      ? ((await crypto.subtle.exportKey("jwk", source)) as JsonWebKey)
      : source;
    return crypto.subtle.importKey("jwk", publicJwkOf(material), params, false, ["verify"]);
  };
  if (isCryptoKey(key)) {
    if (key.type === "public") return key;
    if (key.type === "private") return jwk(key);
    throw new TypeError(`jwt: a symmetric key cannot verify ${alg} tokens`);
  }
  if (typeof key === "object") {
    return "d" in key ? jwk(key) : crypto.subtle.importKey("jwk", key, params, false, ["verify"]);
  }
  // A bare string is an HMAC shared secret: feeding it into an RSA/EC import
  // is the classic algorithm-confusion attack — refuse it outright.
  throw verificationError("algorithm_confusion", `a shared secret cannot verify ${alg} tokens`);
};

export const signJWT = async (
  payload: JWTPayload,
  secret: JWTKey,
  options?: SignOptions,
): Promise<string> => {
  const alg = options?.alg ?? algOfKey(secret) ?? "HS256";
  if (!SUPPORTED.has(alg)) {
    throw new TypeError(`signJWT: unsupported algorithm "${alg}" — HS*/RS*/ES* only`);
  }
  const header = { ...options?.header, alg, typ: "JWT" };
  const signingInput = `${jsonSegment(header)}.${jsonSegment(payload)}`;
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      algorithmParams(alg),
      await signingKey(secret, alg),
      encoder.encode(signingInput),
    ),
  );
  return `${signingInput}.${b64url(raw)}`;
};

/** Resolve the verification whitelist. Setup-shaped mistakes (empty or
 * unsupported lists, family contradictions) are TypeErrors — loud at
 * registration, never silently permissive. */
const resolveAlgorithms = (
  secret: JWTKey,
  algorithms: readonly SignatureAlgorithm[] | undefined,
): readonly SignatureAlgorithm[] => {
  const symmetric = isSymmetricKey(secret);
  const list = algorithms ?? (symmetric ? HS_ALGORITHMS : undefined);
  if (list === undefined) {
    const derived = algOfKey(secret);
    if (derived === undefined) {
      throw new TypeError(
        "jwt: cannot infer the algorithm from this key — pass algorithms explicitly (e.g. an alg-less RSA JWK)",
      );
    }
    return [derived];
  }
  if (list.length === 0)
    throw new TypeError("jwt({ algorithms }) must list at least one algorithm");
  for (const alg of list) {
    if (!SUPPORTED.has(alg)) {
      throw new TypeError(
        `jwt: "${String(alg)}" is not supported — HS*/RS*/ES* only, "none" never`,
      );
    }
    // Algorithm-confusion guard: an HMAC secret must never feed an RSA/EC
    // import, and an asymmetric key can never act as an HMAC secret.
    if (isHmac(alg) !== symmetric) {
      throw new TypeError(
        `jwt: algorithm "${alg}" contradicts the ${symmetric ? "shared secret" : "asymmetric key"}`,
      );
    }
  }
  return list;
};

const DEFAULT_CLOCK_TOLERANCE = 30;

const validateClaims = (payload: JWTPayload, options: VerifyOptions | undefined): void => {
  const now = Math.floor(Date.now() / 1000);
  const tolerance = options?.clockTolerance ?? DEFAULT_CLOCK_TOLERANCE;
  if (payload.nbf !== undefined && (!numeric(payload.nbf) || payload.nbf > now + tolerance)) {
    throw verificationError("invalid_token", "token is not yet valid");
  }
  if (payload.exp !== undefined && (!numeric(payload.exp) || payload.exp <= now - tolerance)) {
    throw verificationError("invalid_token", "token is expired");
  }
  const iss = options?.iss;
  if (iss !== undefined) {
    const claim = payload.iss;
    if (typeof claim !== "string" || !(iss instanceof RegExp ? iss.test(claim) : iss === claim)) {
      throw verificationError("invalid_token", "token issuer mismatch");
    }
  }
  const aud = options?.aud;
  if (aud !== undefined) {
    const claims = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (
      !claims.some((claim) => {
        if (typeof claim !== "string") return false;
        return aud instanceof RegExp
          ? aud.test(claim)
          : Array.isArray(aud)
            ? aud.includes(claim)
            : claim === aud;
      })
    )
      throw verificationError("invalid_token", "token audience mismatch");
  }
};

/** Verify a JWT and return its payload. Pure — no Context, no clock besides
 * `Date.now`, no state. Throws on every failure (shape, algorithm, signature,
 * claims), so callers decide how to answer. */
export const verifyJWT = async (
  token: string,
  secret: JWTKey,
  options?: VerifyOptions,
): Promise<JWTPayload> => {
  const allowed = resolveAlgorithms(secret, options?.algorithms);
  const parts = tokenSegments(token);
  const header = jsonOfSegment(parts[0] as string);
  const headerAlg = header["alg"];
  // "none", unlisted families, missing or non-string algs all die here — the
  // header never gets to pick its own verification primitive.
  if (typeof headerAlg !== "string" || !allowed.includes(headerAlg as SignatureAlgorithm)) {
    throw verificationError("invalid_token", "token algorithm is missing or not allowed");
  }
  if (header["typ"] !== undefined && header["typ"] !== "JWT")
    throw verificationError("invalid_token", "token typ is not JWT");
  const alg = headerAlg as SignatureAlgorithm;
  const payload = jsonOfSegment(parts[1] as string) as JWTPayload;
  // Signature first — never act on (or log) claims that are not yet verified.
  const data = encoder.encode(`${parts[0]}.${parts[1]}`);
  if (!(await signatureMatches(secret, alg, data, decodeSegment(parts[2] as string)))) {
    throw verificationError("invalid_token", "signature mismatch");
  }
  validateClaims(payload, options);
  return payload;
};

/** One signature check, both families: HMAC signed and constant-time compared
 * by us; asymmetric verification via crypto.subtle.verify. */
const signatureMatches = async (
  secret: JWTKey,
  alg: SignatureAlgorithm,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> => {
  const params = algorithmParams(alg);
  if (isHmac(alg)) {
    const key =
      typeof secret === "string"
        ? await crypto.subtle.importKey("raw", encoder.encode(secret), params, false, ["sign"])
        : isCryptoKey(secret)
          ? secret
          : await crypto.subtle.importKey("jwk", secret, params, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign(params, key, data));
    return timingSafeEqual(signature, mac);
  }
  return crypto.subtle.verify(params, await verifyingKey(secret, alg), signature, data);
};

// ---------------------------------------------------------------------------
// Request guard (RFC 6750)
// ---------------------------------------------------------------------------

/** True for any whitespace or C0 control byte — never valid inside a token. */
const hasWhitespaceOrControl = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** Extract the bearer credential; null for any other header shape. */
const bearerToken = (header: string): string | null => {
  const space = header.indexOf(" ");
  if (space <= 0 || header.slice(0, space).toLowerCase() !== "bearer") return null;
  const candidate = header.slice(space + 1).trim();
  if (
    candidate.length === 0 ||
    candidate.length > MAX_TOKEN_BYTES ||
    hasWhitespaceOrControl(candidate)
  ) {
    return null;
  }
  return candidate;
};

/** Realm payload for the WWW-Authenticate challenge: `"` and `\` are stripped
 * (an escape would corrupt the quoted-string; basicAuth/bearerAuth alike). */
const realmPayload = (realm: string | undefined): string => {
  const stripped = (realm ?? "Restricted").replaceAll('"', "").replaceAll("\\", "");
  if (stripped.length === 0) {
    throw new TypeError('jwt: realm must keep characters other than \'"\' and "\\"');
  }
  return stripped;
};

/** The 401 challenge (RFC 6750 §3), thrown through the error funnel. */
function unauthorized(
  c: Context,
  challenge: string,
  error: "invalid_request" | "invalid_token",
  message: string,
  cause?: unknown,
): never {
  return c.throw(401, message, {
    headers: { "www-authenticate": `${challenge}, error="${error}"` },
    code: error,
    ...(cause !== undefined ? { cause } : {}),
  });
}

/** JWT request guard: verifies `Authorization: Bearer <token>` (scheme
 * case-insensitive), publishes the payload as `c.state.jwt`, and answers
 * every failure with 401 + WWW-Authenticate — never a 500. Setup errors
 * (bad secret, unusable algorithm list) throw at registration instead:
 *
 * ```ts
 * app.use(jwt({ secret: "it-is-very-secret" }));
 * app.get("/me", (c) => c.text(String((c.state.jwt as JWTPayload).sub)));
 * ``` */
export const jwt = (options: JWTOptions): RouteHandler => {
  const secret = options?.secret;
  if (typeof secret !== "string" && typeof secret !== "object") {
    // Strings are HMAC secrets; objects are JsonWebKeys / CryptoKeys. Anything
    // else (undefined, null) is a setup error.
    throw new TypeError("jwt({ secret }) requires an HMAC secret or a public key");
  }
  if (typeof secret === "string" && secret.length === 0) {
    throw new TypeError("jwt({ secret }) refuses an empty secret");
  }
  const tolerance = options.clockTolerance;
  if (tolerance !== undefined && (!Number.isFinite(tolerance) || tolerance < 0)) {
    throw new TypeError("jwt({ clockTolerance }) must be a non-negative number of seconds");
  }
  // Eager setup validation: whitelist + confusion guards fire at registration
  // time, never per request.
  const verifyOptions: VerifyOptions = {
    algorithms: resolveAlgorithms(secret, options.algorithms),
    iss: options.iss,
    aud: options.aud,
    clockTolerance: tolerance,
  };
  const challenge = `Bearer realm="${realmPayload(options.realm)}"`;
  return async (c, next) => {
    const token = bearerToken(c.header("authorization"));
    if (token === null) {
      unauthorized(c, challenge, "invalid_request", "missing or malformed bearer token");
    }
    let payload: JWTPayload | undefined;
    try {
      payload = await verifyJWT(token, secret, verifyOptions);
    } catch (err) {
      // Every verification failure — bad shape, unlisted algorithm, wrong
      // key, tampering, expiry, not-yet-valid, issuer/audience — is a 401
      // (RFC 6750 error="invalid_token").
      unauthorized(c, challenge, "invalid_token", "invalid bearer token", err);
    }
    // Review M6: strip the __proto__ own key — a payload carrying it would
    // set the prototype of any downstream Object.assign({}, c.state.jwt).
    if (typeof payload === "object" && payload !== null && "__proto__" in payload) {
      const clean = Object.create(null);
      for (const key of Object.keys(payload)) {
        if (key !== "__proto__") clean[key] = (payload as Record<string, unknown>)[key];
      }
      c.state.jwt = clean;
    } else {
      c.state.jwt = payload;
    }
    await next();
  };
};
