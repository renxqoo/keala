import { expect, it } from "vitest";
import { bunPasswordHasher, hashPassword, verifyPassword } from "../../index.ts";

it("Bun hashing verifies matching passwords instead of interpreting the password as a hash", async () => {
  if (typeof Bun === "undefined") {
    expect(() => bunPasswordHasher()).toThrow(/Bun runtime/);
    return;
  }
  const hasher = bunPasswordHasher();
  const hash = await hashPassword("correct password", hasher);
  expect(await verifyPassword(hash, "correct password", hasher)).toBe(true);
  expect(await verifyPassword(hash, "wrong password", hasher)).toBe(false);
});
