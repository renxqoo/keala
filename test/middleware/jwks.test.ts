/**
 * N5 jwks — remote JWKS key source for OIDC-style JWT verification.
 *
 * Locks the fetch/cache/verify contract against a stubbed IdP endpoint:
 * kid-indexed caching with TTL, single-flight refresh, stale-serving on
 * network failure, rotation via `refresh()`, RSA + EC key families,
 * unsupported kty (oct) skipped, and the always-boolean `verify()`.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { signJWT } from "../../src/middleware/jwt.ts";
import { jwks, type JwkKey } from "../../src/middleware/jwks.ts";

const quiet = { env: "test" } as const;
const req = (path: string): Request => new Request(`http://localhost:3000${path}`);
const URL_JWKS = "https://auth.example.com/.well-known/jwks.json";

/** A controllable IdP: mutable key set, fetch counter, network kill switch. */
class Idp {
  keys: JwkKey[] = [];
  hits = 0;
  down = false;
  readonly fetch = async (): Promise<Response> => {
    this.hits += 1;
    if (this.down) throw new Error("network unreachable");
    return new Response(JSON.stringify({ keys: this.keys }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

interface RsaFixture {
  jwk: JwkKey;
  private: CryptoKey;
}

let primary: RsaFixture; // kid "key-1" — the IdP's active signing key
let rotated: RsaFixture; // kid "key-2" — the post-rotation key
let unrelated: RsaFixture; // kid "key-9" — never published
let ecJwk: JwkKey;
let ecPrivate: CryptoKey;

const rsaJwk = async (kid: string): Promise<RsaFixture> => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JwkKey;
  return {
    jwk: { ...exported, kid, alg: "RS256", use: "sig" },
    private: pair.privateKey,
  };
};

beforeAll(async () => {
  primary = await rsaJwk("key-1");
  rotated = await rsaJwk("key-2");
  unrelated = await rsaJwk("key-9");
  const ecPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const exported = (await crypto.subtle.exportKey("jwk", ecPair.publicKey)) as JwkKey;
  ecJwk = { ...exported, kid: "ec-1", alg: "ES256", use: "sig" };
  ecPrivate = ecPair.privateKey;
});

const signedBy = async (fixture: RsaFixture): Promise<string> =>
  signJWT({ sub: "user-1" }, fixture.private, { alg: "RS256", header: { kid: fixture.jwk.kid } });

/** App with the warmup middleware mounted plus one plain route. */
const warmedApp = (keys: { warmup(): unknown }): Keala => {
  const app = new Keala(quiet);
  app.use(keys.warmup() as never);
  app.get("/x", (c) => c.text("ok"));
  return app;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jwks verify (RSA)", () => {
  it("warmup loads the key set; a valid JWT verifies true", async () => {
    const idp = new Idp();
    idp.keys = [primary.jwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS });
    const app = warmedApp(keys);
    const res = await app.handle(req("/x"));
    expect(res.status).toBe(200);
    expect(idp.hits).toBe(1);
    await expect(keys.verify(await signedBy(primary))).resolves.toBe(true);
  });

  it("an unknown kid forces exactly one refresh, then answers false", async () => {
    const idp = new Idp();
    idp.keys = [primary.jwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS, cache: 600_000 });
    await warmedApp(keys).handle(req("/x"));
    // key-9 is signed by a real key but never published by the IdP.
    await expect(keys.verify(await signedBy(unrelated))).resolves.toBe(false);
    expect(idp.hits).toBe(2); // warmup + the one rotation retry
    // A repeat within the fresh window does not hammer the endpoint again.
    await expect(keys.verify(await signedBy(unrelated))).resolves.toBe(false);
    expect(idp.hits).toBe(2);
  });

  it("a tampered signature under a known kid is false", async () => {
    const idp = new Idp();
    idp.keys = [primary.jwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS });
    await warmedApp(keys).handle(req("/x"));
    const [h, p] = (await signedBy(primary)).split(".");
    const forged = `${h}.${p}.c2lnbmF0dXJl`; // payload re-signed by nobody
    await expect(keys.verify(forged)).resolves.toBe(false);
  });

  it("a token without kid falls back to a single-key key set", async () => {
    const idp = new Idp();
    idp.keys = [primary.jwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS });
    await warmedApp(keys).handle(req("/x"));
    const token = await signJWT({ sub: "u" }, primary.private, { alg: "RS256" });
    await expect(keys.verify(token)).resolves.toBe(true);
  });

  it("a malformed token is false, never a throw", async () => {
    const idp = new Idp();
    idp.keys = [primary.jwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS });
    await expect(keys.verify("not-a-jwt")).resolves.toBe(false);
    await expect(keys.verify("")).resolves.toBe(false);
    // A decodable header segment that is not JSON is the same answer.
    const bogusHeader = `${Buffer.from("<<<not-json>>>").toString("base64url")}.e30.c2ln`;
    await expect(keys.verify(bogusHeader)).resolves.toBe(false);
  });

  it("setup validation refuses a missing url and a bad cache TTL", () => {
    expect(() => jwks({} as never)).toThrow(TypeError);
    expect(() => jwks({ url: URL_JWKS, cache: -1 })).toThrow(TypeError);
    expect(() => jwks({ url: URL_JWKS, cache: Number.NaN })).toThrow(TypeError);
  });
});

describe("jwks cache lifecycle", () => {
  it("within the TTL repeated verifies do not re-fetch", async () => {
    const idp = new Idp();
    idp.keys = [primary.jwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS, cache: 600_000 });
    await warmedApp(keys).handle(req("/x"));
    const token = await signedBy(primary);
    for (let i = 0; i < 3; i += 1) await expect(keys.verify(token)).resolves.toBe(true);
    expect(idp.hits).toBe(1);
  });

  it("after the TTL the next verify re-fetches", async () => {
    const idp = new Idp();
    idp.keys = [primary.jwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS, cache: 25 });
    await warmedApp(keys).handle(req("/x"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(keys.verify(await signedBy(primary))).resolves.toBe(true);
    expect(idp.hits).toBe(2);
  });

  it("a network failure serves the stale cache and keeps answering", async () => {
    const idp = new Idp();
    idp.keys = [primary.jwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS, cache: 25 });
    await warmedApp(keys).handle(req("/x"));
    const token = await signedBy(primary);
    await new Promise((resolve) => setTimeout(resolve, 40));
    idp.down = true;
    await expect(keys.verify(token)).resolves.toBe(true); // stale key serves
    expect(idp.hits).toBe(2); // the failed attempt was made
    await expect(keys.verify(token)).resolves.toBe(true); // backed off: no retry
    expect(idp.hits).toBe(2);
  });

  it("refresh() rotates the key set even inside the TTL", async () => {
    const idp = new Idp();
    idp.keys = [primary.jwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS, cache: 600_000 });
    await warmedApp(keys).handle(req("/x"));
    const oldToken = await signedBy(primary);
    await expect(keys.verify(oldToken)).resolves.toBe(true);
    idp.keys = [rotated.jwk]; // the IdP rotated while we were fresh
    await keys.refresh();
    expect(idp.hits).toBe(2); // warmup + the manual refresh
    await expect(keys.verify(oldToken)).resolves.toBe(false);
    expect(idp.hits).toBe(3); // the stale key-1 kid missed → one re-check
    await expect(keys.verify(await signedBy(rotated))).resolves.toBe(true);
    expect(idp.hits).toBe(3); // a kid hit never fetches
  });

  it("concurrent cold-start verifies share one fetch (single flight)", async () => {
    const idp = new Idp();
    idp.keys = [primary.jwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS });
    const token = await signedBy(primary);
    const verdicts = await Promise.all([keys.verify(token), keys.verify(token)]);
    expect(verdicts).toEqual([true, true]);
    expect(idp.hits).toBe(1);
  });
});

describe("jwks endpoint shapes", () => {
  it("a non-200 endpoint answer is false, not a crash", async () => {
    let hits = 0;
    vi.stubGlobal("fetch", (async () => {
      hits += 1;
      return new Response("rate limited", { status: 503 });
    }) as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS });
    await warmedApp(keys).handle(req("/x"));
    await expect(keys.verify(await signedBy(primary))).resolves.toBe(false);
    expect(hits).toBe(2); // warmup attempt + the verify retry
  });

  it("a JSON document without a keys array is a refresh failure", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response('{"error":"nope"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );
    const keys = jwks({ url: URL_JWKS });
    const app = warmedApp(keys); // cold: the bad doc cannot block startup
    expect((await app.handle(req("/x"))).status).toBe(200);
    await expect(keys.verify(await signedBy(primary))).resolves.toBe(false);
    await expect(keys.refresh()).rejects.toThrow(/keys/);
  });

  it("an RSA key pinned to a non-RS* alg is skipped like oct", async () => {
    const idp = new Idp();
    idp.keys = [
      { ...primary.jwk, kid: "pss-1", alg: "PS256" }, // RSA-PSS: not our verify primitive
      ecJwk,
    ];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS });
    await warmedApp(keys).handle(req("/x"));
    expect((await keys.keys()).map((k) => k.kid)).toEqual(["ec-1"]);
  });

  it("an unknown-kid re-check against a down IdP stays false (no key to serve)", async () => {
    const idp = new Idp();
    idp.keys = [primary.jwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS, cache: 25 });
    await warmedApp(keys).handle(req("/x"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    idp.down = true;
    // The stale set expired AND the kid is unknown: the re-check fails, so
    // nothing (stale or fresh) can vouch for this token.
    await expect(keys.verify(await signedBy(unrelated))).resolves.toBe(false);
  });

  it("warmup swallows a failing first fetch; verify retries and recovers", async () => {
    const idp = new Idp();
    idp.down = true;
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS });
    const res = await warmedApp(keys).handle(req("/x")); // startup not blocked
    expect(res.status).toBe(200);
    await expect(keys.verify(await signedBy(primary))).resolves.toBe(false); // still down
    idp.down = false;
    idp.keys = [primary.jwk];
    await expect(keys.verify(await signedBy(primary))).resolves.toBe(true); // recovered
  });

  it("an empty key set verifies false without throwing", async () => {
    const idp = new Idp(); // keys: []
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS });
    await warmedApp(keys).handle(req("/x"));
    await expect(keys.verify(await signedBy(primary))).resolves.toBe(false);
  });

  it("non-RSA/EC kty entries (oct) are skipped, not trusted", async () => {
    const idp = new Idp();
    idp.keys = [{ kty: "oct", kid: "oct-1", k: "c2VjcmV0", alg: "HS256", use: "sig" }, primary.jwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS });
    await warmedApp(keys).handle(req("/x"));
    const list = await keys.keys();
    expect(list.map((k) => k.kid)).toEqual(["key-1"]);
    const hsToken = await signJWT({ sub: "u" }, "secret", { header: { kid: "oct-1" } });
    await expect(keys.verify(hsToken)).resolves.toBe(false);
  });

  it("EC (ES256) keys from the JWKS verify", async () => {
    const idp = new Idp();
    idp.keys = [ecJwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS });
    await warmedApp(keys).handle(req("/x"));
    const token = await signJWT({ sub: "ec-user" }, ecPrivate, {
      alg: "ES256",
      header: { kid: "ec-1" },
    });
    await expect(keys.verify(token)).resolves.toBe(true);
  });

  it("keys() exposes the published JWK material", async () => {
    const idp = new Idp();
    idp.keys = [primary.jwk, ecJwk];
    vi.stubGlobal("fetch", idp.fetch as unknown as typeof fetch);
    const keys = jwks({ url: URL_JWKS });
    await warmedApp(keys).handle(req("/x"));
    const list = await keys.keys();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ kty: "RSA", kid: "key-1", alg: "RS256", use: "sig" });
    expect(list[1]).toMatchObject({ kty: "EC", kid: "ec-1", crv: "P-256" });
    expect(typeof list[0]?.n).toBe("string");
  });
});
