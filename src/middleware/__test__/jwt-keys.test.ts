import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { Keala } from "../../index.ts";
import { jwt, signJWT, verifyJWT } from "../index.ts";

it("does not reject valid JWTs when the HMAC CryptoKey only permits verification", async () => {
  const secret = "verify-only-hmac-secret";
  const token = await signJWT({ sub: "alice" }, secret);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  await expect(verifyJWT(token, key)).resolves.toEqual({ sub: "alice" });
  const app = new Keala({ env: "test" });
  app.get("/me", jwt({ secret: key }), (c) => c.json(c.state.jwt));
  const response = await app.handle(
    new Request("http://test/me", { headers: { authorization: `Bearer ${token}` } }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sub: "alice" });
});

it("does not label an HMAC SHA-256 CryptoKey signature as HS512", async () => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("algorithm-bound-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  await expect(signJWT({ sub: "alice" }, key, { alg: "HS512" })).rejects.toThrow(TypeError);
});

it("does not accept a SHA-256 MAC under an HS512 whitelist with a CryptoKey", async () => {
  const secret = "algorithm-bound-secret";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const header = Buffer.from('{"alg":"HS512","typ":"JWT"}').toString("base64url");
  const payload = Buffer.from('{"sub":"alice"}').toString("base64url");
  const input = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(input).digest("base64url");
  await expect(
    verifyJWT(`${input}.${signature}`, key, { algorithms: ["HS512"] }),
  ).rejects.toThrow();
  await expect(verifyJWT(`${input}.${signature}`, key)).rejects.toThrow();
  expect(() => jwt({ secret: key, algorithms: ["HS512"] })).toThrow(TypeError);
});

it("does not sign an ECDSA token using a curve that contradicts its JOSE algorithm", async () => {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  await expect(signJWT({ sub: "alice" }, key.privateKey, { alg: "ES384" })).rejects.toThrow(
    TypeError,
  );
  const token = await signJWT({ sub: "alice" }, key.privateKey);
  await expect(verifyJWT(token, key.publicKey)).resolves.toEqual({ sub: "alice" });
});
