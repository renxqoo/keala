/**
 * Realm sanitization tests (SEC-5): a realm containing `\` used to corrupt
 * the WWW-Authenticate challenge — only `"` was stripped, so a realm ending
 * in a backslash terminated the quoted-string early (`realm="My\"` leaves
 * the closing quote escaped and the parameter value dangling). Both quote
 * classes are stripped now, and a realm that strips to nothing is a setup
 * error.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { basicAuth, bearerAuth } from "../src/middleware/auth.ts";
import type { RouteHandler } from "../src/router/router.ts";

const quiet = { env: "test" } as const;
const verify = (_credentials: string) => true;
const req = () => new Request("http://localhost:3000/private");

const challengeOf = async (middleware: RouteHandler): Promise<string> => {
  const app = new Keala(quiet);
  app.use(middleware);
  const res = await app.handle(req());
  return res.headers.get("www-authenticate") ?? "";
};

describe("auth realm: quoted-string safety", () => {
  it("a trailing backslash no longer dangles the quote (the SEC-5 repro)", async () => {
    // realm value: "My " + one backslash — the old challenge was
    // `realm="My\"` (closing quote escaped, value unterminated).
    const challenge = await challengeOf(basicAuth({ verify, realm: "My \\" }));
    expect(challenge).toBe('Basic realm="My ", charset="UTF-8"');
    // The parameter stays a closed quoted-string: balanced quotes.
    expect((challenge.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it("quotes are still stripped (locked behavior)", async () => {
    const challenge = await challengeOf(basicAuth({ verify, realm: 'Admin "Area"' }));
    expect(challenge).toBe('Basic realm="Admin Area", charset="UTF-8"');
  });

  it("mixed quotes and backslashes all strip", async () => {
    const challenge = await challengeOf(basicAuth({ verify, realm: 'a"b\\c"d' }));
    expect(challenge).toContain('realm="abcd"');
  });

  it("the default realm is untouched", async () => {
    const challenge = await challengeOf(basicAuth({ verify }));
    expect(challenge).toBe('Basic realm="Restricted", charset="UTF-8"');
  });

  it("a realm that strips to nothing is a loud setup error (both middlewares)", () => {
    expect(() => basicAuth({ verify, realm: '""' })).toThrow(TypeError);
    expect(() => basicAuth({ verify, realm: "\\" })).toThrow(/basicAuth: realm/);
    expect(() => bearerAuth({ verify, realm: '"\\\\"' })).toThrow(/bearerAuth: realm/);
  });

  it("bearerAuth realms get the same treatment", async () => {
    const challenge = await challengeOf(bearerAuth({ verify, realm: "API v\\2" }));
    expect(challenge).toBe('Bearer realm="API v2"');
  });
});
