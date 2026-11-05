import { expect, it } from "vitest";
import { csrfToken } from "../index.ts";

it.each([undefined, 60_000])(
  "rejects a same-secret long-lived token after the verifier TTL with maxAge %s",
  async (maxAge) => {
    const issuer = csrfToken({ secret: "shared-policy-secret", expiresIn: 60_000 });
    const verifier = csrfToken({
      secret: "shared-policy-secret",
      expiresIn: 20,
      ...(maxAge !== undefined ? { maxAge } : {}),
    });
    const token = issuer.issue("session");
    expect(verifier.verify(token, "session")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(issuer.verify(token, "session")).toBe(true);
    expect(verifier.verify(token, "session")).toBe(false);
  },
);
