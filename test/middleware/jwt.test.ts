import { beforeAll, describe, expect, it } from "vitest";
import type { JsonWebKey } from "node:crypto";

import { Keala } from "../../src/core/app.ts";
import {
  jwt,
  signJWT,
  verifyJWT,
  type JWTKey,
  type JWTOptions,
  type JWTPayload,
} from "../../src/middleware/jwt.ts";
/**
 * jwt middleware + signJWT/verifyJWT primitives: HS/RS/ES round-trips over
 * every key-material shape, the security locks (algorithm whitelist, `none`
 * rejection, algorithm confusion, tampering, exp/nbf/iss/aud) and the
 * RFC 6750 request-guard behavior.
 */

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);
const nowSec = () => Math.floor(Date.now() / 1000);
const b64url = (value: object | string): string =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const headerOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[0] as string, "base64url").toString());

/** Hand-build a token without touching the signer (forgery-shaped by design). */
const forge = (
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signature = "c2ln",
): string => `${b64url(header)}.${b64url(payload)}.${signature}`;

/** Swap in a different payload under the original signature. */
const tamperPayload = (token: string, payload: Record<string, unknown>): string => {
  const [h, , s] = token.split(".");
  return `${h}.${b64url(payload)}.${s}`;
};

interface KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

type RsaAlg = "RS256" | "RS384" | "RS512";
type EcAlg = "ES256" | "ES384" | "ES512";
const RSA_HASHES: Record<RsaAlg, string> = { RS256: "SHA-256", RS384: "SHA-384", RS512: "SHA-512" };
const EC_CURVES: Record<EcAlg, string> = { ES256: "P-256", ES384: "P-384", ES512: "P-521" };

const rsaKeys = {} as Record<RsaAlg, KeyPair>;
const ecKeys = {} as Record<EcAlg, KeyPair>;
let otherRsa: KeyPair; // a second, unrelated RSA pair
let rsaPrivateJwk: JsonWebKey;
let rsaPublicJwk: JsonWebKey;

beforeAll(async () => {
  // One 2048-bit RSA keypair serves all three hashes — the hash is an IMPORT
  // parameter, so the exported SPKI/PKCS#8 blobs re-import per variant.
  const generated = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const spki = await crypto.subtle.exportKey("spki", generated.publicKey);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", generated.privateKey);
  for (const [alg, hash] of Object.entries(RSA_HASHES)) {
    rsaKeys[alg as RsaAlg] = {
      publicKey: await crypto.subtle.importKey(
        "spki",
        spki,
        { name: "RSASSA-PKCS1-v1_5", hash },
        true,
        ["verify"],
      ),
      privateKey: await crypto.subtle.importKey(
        "pkcs8",
        pkcs8,
        { name: "RSASSA-PKCS1-v1_5", hash },
        true,
        ["sign"],
      ),
    };
  }
  for (const [alg, namedCurve] of Object.entries(EC_CURVES)) {
    ecKeys[alg as EcAlg] = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve }, true, [
      "sign",
      "verify",
    ]);
  }
  otherRsa = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  rsaPrivateJwk = (await crypto.subtle.exportKey("jwk", generated.privateKey)) as JsonWebKey;
  rsaPublicJwk = (await crypto.subtle.exportKey("jwk", generated.publicKey)) as JsonWebKey;
});

const guarded = (options: JWTOptions): Keala => {
  const app = new Keala(quiet);
  app.use(jwt(options));
  app.get("/me", (c) => {
    const payload = c.state.jwt as JWTPayload | undefined;
    return c.text(payload === undefined ? "anon" : `sub=${String(payload.sub)}`);
  });
  return app;
};

describe("signJWT / verifyJWT round-trips", () => {
  it("HS256 round-trips with the payload intact", async () => {
    const token = await signJWT(
      { sub: "user-1", role: "admin", iat: 1_700_000_000 },
      "shared-secret",
    );
    expect(token.split(".")).toHaveLength(3);
    expect(headerOf(token)).toMatchObject({ alg: "HS256", typ: "JWT" });
    const payload = await verifyJWT(token, "shared-secret");
    expect(payload).toMatchObject({ sub: "user-1", role: "admin", iat: 1_700_000_000 });
  });

  it.each(["HS384", "HS512"] as const)("round-trips %s", async (alg) => {
    const token = await signJWT({ sub: "u" }, "shared-secret", { alg });
    await expect(verifyJWT(token, "shared-secret")).resolves.toMatchObject({ sub: "u" });
  });

  it.each(["RS256", "RS384", "RS512"] as const)("round-trips %s (WebCrypto keys)", async (alg) => {
    const token = await signJWT({ sub: "rsa-user" }, rsaKeys[alg].privateKey, { alg });
    await expect(verifyJWT(token, rsaKeys[alg].publicKey)).resolves.toMatchObject({
      sub: "rsa-user",
    });
  });

  it.each(["ES256", "ES384", "ES512"] as const)("round-trips %s (WebCrypto keys)", async (alg) => {
    const token = await signJWT({ sub: "ec-user" }, ecKeys[alg].privateKey, { alg });
    await expect(verifyJWT(token, ecKeys[alg].publicKey)).resolves.toMatchObject({
      sub: "ec-user",
    });
  });

  it("emits ES256 signatures in the WebCrypto raw r||s form (64 bytes for P-256)", async () => {
    const token = await signJWT({ sub: "ec" }, ecKeys.ES256.privateKey, { alg: "ES256" });
    const raw = Buffer.from(token.split(".")[2] as string, "base64url");
    expect(raw).toHaveLength(64); // two 32-byte coordinates, no ASN.1 framing
    await expect(verifyJWT(token, ecKeys.ES256.publicKey)).resolves.toMatchObject({ sub: "ec" });
  });

  it("carries extra header fields (kid) but keeps alg/typ under its control", async () => {
    const token = await signJWT({ sub: "x" }, "shared-secret", {
      header: { kid: "key-7", alg: "none", typ: "JWT" },
    });
    expect(headerOf(token)).toEqual({ kid: "key-7", alg: "HS256", typ: "JWT" });
  });

  it("rejects a token signed with a different HMAC secret", async () => {
    const token = await signJWT({ sub: "u" }, "alpha-secret");
    await expect(verifyJWT(token, "beta-secret")).rejects.toThrow();
  });

  it("rejects an RS256 token verified with an unrelated public key", async () => {
    const token = await signJWT({ sub: "u" }, otherRsa.privateKey, { alg: "RS256" });
    await expect(verifyJWT(token, rsaKeys.RS256.publicKey)).rejects.toThrow();
  });
});

describe("key material shapes", () => {
  it("round-trips private JWK (sign) / public JWK (verify)", async () => {
    const token = await signJWT({ sub: "jwk-user" }, rsaPrivateJwk);
    expect(headerOf(token).alg).toBe("RS256"); // alg derived from the JWK's own alg field
    await expect(verifyJWT(token, rsaPublicJwk)).resolves.toMatchObject({ sub: "jwk-user" });
    // A PRIVATE JWK still verifies — only its public half is imported.
    await expect(verifyJWT(token, rsaPrivateJwk)).resolves.toMatchObject({ sub: "jwk-user" });
  });

  it("verifies against a private CryptoKey by deriving its public half", async () => {
    const token = await signJWT({ sub: "u" }, rsaKeys.RS256.privateKey, { alg: "RS256" });
    await expect(verifyJWT(token, rsaKeys.RS256.privateKey)).resolves.toMatchObject({ sub: "u" });
  });

  it("refuses to sign with a public key or a bare shared secret for RS*", async () => {
    await expect(signJWT({ sub: "u" }, rsaKeys.RS256.publicKey, { alg: "RS256" })).rejects.toThrow(
      TypeError,
    );
    await expect(signJWT({ sub: "u" }, "shared-secret", { alg: "RS256" })).rejects.toThrow(
      TypeError,
    );
  });
});

describe("security locks", () => {
  it("rejects alg:none tokens (unsigned)", async () => {
    const token = forge({ alg: "none", typ: "JWT" }, { sub: "attacker" });
    await expect(verifyJWT(token, "shared-secret")).rejects.toThrow();
  });

  it("rejects alg:none with a trailing empty signature segment", async () => {
    const token = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: "a" })}.`;
    await expect(verifyJWT(token, "shared-secret")).rejects.toThrow();
  });

  it("rejects header algs outside the configured whitelist", async () => {
    const token = await signJWT({ sub: "u" }, "shared-secret", { alg: "HS384" });
    await expect(verifyJWT(token, "shared-secret", { algorithms: ["HS256"] })).rejects.toThrow();
    const app = guarded({ secret: "shared-secret", algorithms: ["HS256"] });
    expect((await app.handle(req("/me", { headers: bearer(token) }))).status).toBe(401);
  });

  it("refuses an HMAC secret powering RSA verification (algorithm confusion)", async () => {
    const rsaToken = await signJWT({ sub: "attacker" }, rsaKeys.RS256.privateKey, { alg: "RS256" });
    // Whitelist default for a string secret is the HS family → RS256 dies there…
    await expect(verifyJWT(rsaToken, "shared-secret")).rejects.toThrow();
    // …and force-listing an asymmetric alg with a shared secret is a setup error.
    await expect(verifyJWT(rsaToken, "shared-secret", { algorithms: ["RS256"] })).rejects.toThrow(
      TypeError,
    );
    expect(() => jwt({ secret: "shared-secret", algorithms: ["RS256"] })).toThrow(TypeError);
    expect(
      (await guarded({ secret: "shared-secret" }).handle(req("/me", { headers: bearer(rsaToken) })))
        .status,
    ).toBe(401);
  });

  it("rejects a tampered payload", async () => {
    const token = await signJWT({ sub: "user-1", admin: false }, "shared-secret");
    const forged = tamperPayload(token, { sub: "user-1", admin: true });
    await expect(verifyJWT(forged, "shared-secret")).rejects.toThrow();
    const app = guarded({ secret: "shared-secret" });
    expect((await app.handle(req("/me", { headers: bearer(forged) }))).status).toBe(401);
  });

  it("rejects a tampered signature", async () => {
    const token = await signJWT({ sub: "u" }, "shared-secret");
    const [h, p] = token.split(".");
    const forged = `${h}.${p}.${Buffer.from("tamper").toString("base64url")}`;
    await expect(verifyJWT(forged, "shared-secret")).rejects.toThrow();
  });

  it("rejects an expired token (exp in the past)", async () => {
    const token = await signJWT({ sub: "u", exp: nowSec() - 3_600 }, "shared-secret");
    await expect(verifyJWT(token, "shared-secret")).rejects.toThrow();
    expect(
      (await guarded({ secret: "shared-secret" }).handle(req("/me", { headers: bearer(token) })))
        .status,
    ).toBe(401);
  });

  it("rejects a token that is not yet valid (nbf in the future)", async () => {
    const token = await signJWT({ sub: "u", nbf: nowSec() + 3_600 }, "shared-secret");
    await expect(verifyJWT(token, "shared-secret")).rejects.toThrow();
    expect(
      (await guarded({ secret: "shared-secret" }).handle(req("/me", { headers: bearer(token) })))
        .status,
    ).toBe(401);
  });

  it("honors clockTolerance: mildly-expired passes at 30s, fails at 0", async () => {
    const token = await signJWT({ sub: "u", exp: nowSec() - 5 }, "shared-secret");
    await expect(verifyJWT(token, "shared-secret")).resolves.toMatchObject({ sub: "u" });
    await expect(verifyJWT(token, "shared-secret", { clockTolerance: 0 })).rejects.toThrow();
  });

  it("enforces iss when provided (exact, RegExp, missing)", async () => {
    const token = await signJWT({ sub: "u", iss: "https://issuer.example" }, "shared-secret");
    await expect(
      verifyJWT(token, "shared-secret", { iss: "https://issuer.example" }),
    ).resolves.toMatchObject({ sub: "u" });
    await expect(
      verifyJWT(token, "shared-secret", { iss: /^https:\/\/issuer/ }),
    ).resolves.toBeDefined();
    await expect(
      verifyJWT(token, "shared-secret", { iss: "https://other.example" }),
    ).rejects.toThrow();
    const unissued = await signJWT({ sub: "u" }, "shared-secret");
    await expect(
      verifyJWT(unissued, "shared-secret", { iss: "https://issuer.example" }),
    ).rejects.toThrow();
  });

  it("enforces aud when provided (string, list, RegExp, mismatch)", async () => {
    const token = await signJWT({ sub: "u", aud: ["api-a", "api-b"] }, "shared-secret");
    await expect(verifyJWT(token, "shared-secret", { aud: "api-b" })).resolves.toBeDefined();
    await expect(
      verifyJWT(token, "shared-secret", { aud: ["api-c", "api-a"] }),
    ).resolves.toBeDefined();
    await expect(verifyJWT(token, "shared-secret", { aud: /^api-/ })).resolves.toBeDefined();
    await expect(verifyJWT(token, "shared-secret", { aud: "api-c" })).rejects.toThrow();
    const unaddressed = await signJWT({ sub: "u" }, "shared-secret");
    await expect(verifyJWT(unaddressed, "shared-secret", { aud: "api-a" })).rejects.toThrow();
  });

  it.each([
    ["two segments", "only.two"],
    ["four segments", "a.b.c.d"],
    ["bare garbage", "garbage"],
    [
      "non-base64url chars",
      `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "u" })}.c2ln!`,
    ],
    ["non-JSON payload", `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url("not-json")}.c2ln`],
  ])("rejects a malformed token (%s)", async (_label, token) => {
    await expect(verifyJWT(token, "shared-secret")).rejects.toThrow();
  });
});

describe("jwt middleware", () => {
  it("accepts a valid bearer token, publishes c.state.jwt and calls next", async () => {
    const app = guarded({ secret: "shared-secret" });
    const token = await signJWT({ sub: "user-1" }, "shared-secret");
    const res = await app.handle(req("/me", { headers: bearer(token) }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("sub=user-1");
  });

  it("matches the bearer scheme case-insensitively", async () => {
    const token = await signJWT({ sub: "user-1" }, "shared-secret");
    const res = await guarded({ secret: "shared-secret" }).handle(
      req("/me", { headers: { authorization: `bEaReR ${token}` } }),
    );
    expect(res.status).toBe(200);
  });

  it("answers 401 + WWW-Authenticate challenge when the header is missing", async () => {
    const res = await guarded({ secret: "shared-secret" }).handle(req("/me"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="Restricted", error="invalid_request"',
    );
  });

  it("uses the configured realm", async () => {
    const res = await guarded({ secret: "shared-secret", realm: "api" }).handle(req("/me"));
    expect(res.headers.get("www-authenticate")).toContain('realm="api"');
  });

  it.each([
    ["wrong scheme", { authorization: `Basic ${b64url("u:p")}` }],
    ["bare scheme", { authorization: "Bearer" }],
    ["empty credential", { authorization: "Bearer " }],
    ["whitespace inside the token", { authorization: `Bearer ${b64url({ sub: "u" })} x` }],
  ])("answers 401 for %s", async (_label, headers) => {
    const res = await guarded({ secret: "shared-secret" }).handle(req("/me", { headers }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_request"');
  });

  it.each([
    ["two segments", "only.two"],
    ["garbage", "garbage"],
    ["empty credential", "a.b."],
  ])("answers 401 for a malformed token (%s)", async (_label, token) => {
    const res = await guarded({ secret: "shared-secret" }).handle(
      req("/me", { headers: bearer(token) }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it('answers 401 + error="invalid_token" when verification fails', async () => {
    const token = await signJWT({ sub: "u" }, "wrong-secret");
    const res = await guarded({ secret: "shared-secret" }).handle(
      req("/me", { headers: bearer(token) }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="Restricted", error="invalid_token"',
    );
  });
});

describe("setup validation", () => {
  it("throws on a missing or empty secret", () => {
    // @ts-expect-error -- runtime contract check for JS callers
    expect(() => jwt({})).toThrow(TypeError);
    expect(() => jwt({ secret: "" })).toThrow(TypeError);
  });

  it("throws on an empty or unsupported algorithms list", () => {
    expect(() => jwt({ secret: "s", algorithms: [] })).toThrow(TypeError);
    // @ts-expect-error -- "none" is never a valid algorithm
    expect(() => jwt({ secret: "s", algorithms: ["none"] })).toThrow(TypeError);
  });

  it("throws when the algorithm family contradicts the secret kind", () => {
    expect(() => jwt({ secret: "s", algorithms: ["RS256"] })).toThrow(TypeError); // HMAC secret, RSA alg
    expect(() => jwt({ secret: rsaKeys.RS256.publicKey, algorithms: ["HS256"] })).toThrow(
      TypeError,
    ); // public key, HMAC alg
  });

  it("throws on a negative or non-finite clockTolerance", () => {
    expect(() => jwt({ secret: "s", clockTolerance: -1 })).toThrow(TypeError);
    expect(() => jwt({ secret: "s", clockTolerance: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it("cannot infer an algorithm from an alg-less RSA JWK without an explicit list", () => {
    const algless = { ...rsaPublicJwk, alg: undefined } as JWTKey;
    expect(() => jwt({ secret: algless })).toThrow(TypeError);
  });
});
