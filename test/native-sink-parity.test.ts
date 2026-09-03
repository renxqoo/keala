/**
 * Sink parity — L1 of the dual-router differential (双路由对拍) the P3 exit
 * gate demands: the JS MIRROR of every sink shape must be indistinguishable
 * from an ordinary JS route across the divergence-prone URL corpus
 * (percent-decoding, trailing slashes, case, method fan-out). The real-Bun
 * legs (native table vs these predictions, and nativeRoutes:false) run in
 * scripts/smoke.ts — Bun-global stubbing cannot reach a genuine Bun.serve.
 *
 * Native-only divergences are LEDGERED in docs/PARITY.md and pinned by the
 * smoke legs, never here: the mirror is the reference, and this suite locks
 * the mirror to the ordinary router.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../src/index.ts";
import { createError } from "../src/http/errors.ts";
import type { SunkHandler } from "../src/index.ts";

const quiet = { env: "test" } as const;

/** Handler shapes shared by the twin apps — bodies depend on params so a
 *  keyspace divergence cannot hide behind a constant. */
const healthHandler: SunkHandler = () =>
  new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });

const userHandler: SunkHandler = (_request, params) => Response.json({ id: params["id"] ?? null });

const postHandler: SunkHandler = (_request, params) =>
  Response.json({ user: params["id"] ?? null, post: params["pid"] ?? null });

const registerPlain = (app: InstanceType<typeof Keala>): void => {
  app.get(
    "/health",
    () => new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } }),
  );
  app.get("/users/:id", (c) => Response.json({ id: c.params?.["id"] ?? null }));
  app.get("/users/:id/posts/:pid", (c) =>
    Response.json({ user: c.params?.["id"] ?? null, post: c.params?.["pid"] ?? null }),
  );
};

const registerSunk = (app: InstanceType<typeof Keala>): void => {
  app.sink("/health", healthHandler);
  app.sink("/users/:id", userHandler);
  app.sink("/users/:id/posts/:pid", postHandler);
};

interface Wire {
  status: number;
  contentType: string | null;
  allow: string | null;
  body: string;
}

const wireOf = async (
  app: InstanceType<typeof Keala>,
  path: string,
  method = "GET",
): Promise<Wire> => {
  const res = await app.handle(new Request(`http://localhost:3000${path}`, { method }));
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    allow: res.headers.get("allow"),
    body: await res.text(),
  };
};

describe("sink parity: the JS mirror matches the ordinary router", () => {
  const corpus: Array<[string, string]> = [
    ["/health", "GET"],
    ["/health", "HEAD"],
    ["/health", "POST"],
    ["/health", "OPTIONS"],
    ["/health/", "GET"],
    ["/Health", "GET"],
    ["/users/12345", "GET"],
    ["/users/caf%C3%A9", "GET"],
    ["/users/%31%32%33", "GET"],
    ["/users/a%2Fb", "GET"],
    ["/users/%zz", "GET"],
    ["/users/", "GET"],
    ["/users", "GET"],
    ["/users/1/posts/2", "GET"],
    ["/users/1/posts/", "GET"],
    ["/definitely-not-here", "GET"],
  ];

  it("every corpus row is byte-identical between mirror and plain routes", async () => {
    const plain = new Keala(quiet);
    registerPlain(plain);
    const sunk = new Keala(quiet);
    registerSunk(sunk);
    for (const [path, method] of corpus) {
      expect(JSON.stringify(await wireOf(sunk, path, method)), `${method} ${path}`).toBe(
        JSON.stringify(await wireOf(plain, path, method)),
      );
    }
  });

  it("malformed escapes pass through verbatim to the handler (security contract #5)", async () => {
    const sunk = new Keala(quiet);
    registerSunk(sunk);
    const res = await wireOf(sunk, "/users/%zz");
    // The mirror decodes per-segment and lets malformed escapes through
    // UNTOUCHED — the native table substitutes U+FFFD (ledgered divergence,
    // pinned by the smoke leg).
    expect(res.body).toBe(JSON.stringify({ id: "%zz" }));
  });

  it("the mirror runs declared-transparent middleware the native table skips", async () => {
    const sunk = new Keala(quiet);
    // An UNDECLARED no-op layer: the mirror applies it (x-mw header rides),
    // which is exactly why a lying noOpFor declaration stays observable.
    sunk.use((_c, next) => next());
    expect(() => registerSunk(sunk)).toThrow(/noOpFor|alongside sunk routes/);
  });

  it("an exposed thrown HttpError answers through the builtin funnel", async () => {
    const sunk = new Keala(quiet);
    sunk.sink("/teapot", () => {
      throw createError(418, "short and stout", { expose: true });
    });
    const res = await wireOf(sunk, "/teapot");
    expect(res.status).toBe(418);
    expect(res.body).toBe("short and stout");
    expect(res.contentType).toMatch(/^text\/plain/);
  });

  it("a non-Response return is a loud 500, never a help page", async () => {
    const sunk = new Keala(quiet);
    // @ts-expect-error -- runtime contract check for JS callers
    sunk.sink("/bad", () => "not a response");
    const res = await wireOf(sunk, "/bad");
    expect(res.status).toBe(500);
    expect(res.body).toBe("Internal Server Error");
  });

  it("async handlers and async rejections keep the same contract", async () => {
    const sunk = new Keala(quiet);
    sunk.sink(
      "/slow",
      async () => new Response("later", { headers: { "content-type": "text/plain" } }),
    );
    sunk.sink("/rejects", async () => {
      throw createError(503, "upstream gone", { expose: true });
    });
    expect((await wireOf(sunk, "/slow")).body).toBe("later");
    const rejected = await wireOf(sunk, "/rejects");
    expect(rejected.status).toBe(503);
    expect(rejected.body).toBe("upstream gone");
  });

  it("params records are null-prototype on the mirror (native parity is probe-locked)", async () => {
    let seen: unknown = "unset";
    const sunk = new Keala(quiet);
    sunk.sink("/probe/:id", (_request, params) => {
      seen = Object.getPrototypeOf(params);
      return new Response("done");
    });
    await wireOf(sunk, "/probe/7");
    expect(seen).toBe(null);
  });
});

describe("production hardening: trustedHosts and unknownMethodAs404", () => {
  it("trustedHosts refuses forged Host authorities before routing", async () => {
    const app = new Keala({ env: "test", trustedHosts: ["example.com", "*.subs.example.com"] });
    app.get("/x", (c) => c.text("reached"));
    const ok = await app.handle(new Request("http://example.com/x"));
    expect([ok.status, await ok.text()]).toEqual([200, "reached"]);
    const wildcard = await app.handle(new Request("http://a.subs.example.com/x"));
    expect(wildcard.status).toBe(200);
    // A port never participates in the authority comparison.
    const withPort = await app.handle(new Request("http://example.com:3000/x"));
    expect(withPort.status).toBe(200);
    const forged = await app.handle(
      new Request("http://evil.com/x", { headers: { host: "evil.com" } }),
    );
    expect([forged.status, await forged.text()]).toEqual([403, "Forbidden Host"]);
    // `deep.subs.example.com` must NOT match `*.subs.example.com` (single label).
    const deep = await app.handle(new Request("http://deep.a.subs.example.com/x"));
    expect(deep.status).toBe(403);
  });

  it("an unset or empty trustedHosts list admits everything", async () => {
    for (const options of [{}, { trustedHosts: [] as string[] }]) {
      const app = new Keala({ env: "test", ...options });
      app.get("/x", (c) => c.text("any"));
      const res = await app.handle(new Request("http://anything.example/x"));
      expect(res.status).toBe(200);
    }
  });

  it("unknownMethodAs404 answers 404 instead of 501 for non-grammar methods", async () => {
    const app = new Keala({ env: "test", unknownMethodAs404: true });
    app.get("/x", (c) => c.text("ok"));
    // Bun's Request constructor silently coerces unknown methods to GET, so
    // the non-grammar leg only runs where Request keeps the method.
    if (typeof Bun === "undefined") {
      const unknown = await app.handle(
        new Request("http://localhost:3000/x", { method: "FROBNICATE" }),
      );
      expect(unknown.status).toBe(404);
    }
    // A KNOWN but unregistered method still gets 405 + Allow.
    const known = await app.handle(new Request("http://localhost:3000/x", { method: "POST" }));
    expect([known.status, known.headers.get("allow")?.split(", ").sort()]).toEqual([
      405,
      ["GET", "HEAD"],
    ]);
  });
});
