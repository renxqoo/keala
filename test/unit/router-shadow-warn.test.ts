/**
 * BUG-5 dev warning (review-0.6.2): a static entry owns its whole path for
 * every method, so a static route overlapping a dynamic pattern flips every
 * method the static side does not serve from the dynamic handler to 405 —
 * in EITHER registration order. Development warns; test/prod stay silent;
 * the static-first precedence itself is design and stays unchanged.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { Router } from "../../src/router/group.ts";

const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);
const dev = { env: "development" } as const;

const warnSink = (): { warns: string[] } => {
  const warns: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warns.push(args.join(" "));
  });
  return { warns };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BUG-5: static-over-dynamic shadow warnings", () => {
  it("static registered after dynamic warns about the method gap", () => {
    const { warns } = warnSink();
    const app = new Keala(dev);
    app.get("/users/:id", (c) => c.text("dyn"));
    app.post("/users/7", (c) => c.text("static"));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("/users/:id");
    expect(warns[0]).toContain("GET");
    expect(warns[0]).toContain("405");
  });

  it("dynamic registered after static warns too (same gap, reverse order)", () => {
    const { warns } = warnSink();
    const app = new Keala(dev);
    app.post("/users/7", (c) => c.text("static"));
    app.get("/users/:id", (c) => c.text("dyn"));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("/users/7");
    expect(warns[0]).toContain("GET");
    expect(warns[0]).toContain("405");
  });

  it("the shadowed method answers 405 while the static one works (precedence unchanged)", async () => {
    warnSink();
    const app = new Keala(dev);
    app.get("/users/:id", (c) => c.text("dyn"));
    app.post("/users/7", (c) => c.text("static"));
    expect((await app.handle(req("/users/7"))).status).toBe(405);
    expect((await app.handle(req("/users/7", { method: "POST" }))).status).toBe(200);
    expect((await app.handle(req("/users/8"))).status).toBe(200);
  });

  it("same-method overlap stays silent (ordinary static precedence)", () => {
    const { warns } = warnSink();
    const app = new Keala(dev);
    app.get("/users/:id", (c) => c.text("dyn"));
    app.get("/users/7", (c) => c.text("static"));
    expect(warns.length).toBe(0);
  });

  it("closing the gap stops the warnings and never repeats an old one", () => {
    const { warns } = warnSink();
    const app = new Keala(dev);
    app.get("/users/:id", (c) => c.text("dyn"));
    app.post("/users/7", (c) => c.text("static"));
    expect(warns.length).toBe(1);
    app.get("/users/7", (c) => c.text("static-get"));
    expect(warns.length).toBe(1);
    // Same gap re-derived by an unrelated registration on the static path.
    app.post("/users/7", (c) => c.text("static-post-2"));
    expect(warns.length).toBe(1);
  });

  it("widening the gap warns again with the new method", () => {
    const { warns } = warnSink();
    const app = new Keala(dev);
    app.post("/users/7", (c) => c.text("static"));
    app.get("/users/:id", (c) => c.text("dyn"));
    expect(warns.length).toBe(1);
    app.put("/users/:id", (c) => c.text("dyn-put"));
    expect(warns.length).toBe(2);
    expect(warns[1]).toContain("PUT");
  });

  it("an ALL dynamic route under a method-specific static path warns broadly", () => {
    const { warns } = warnSink();
    const app = new Keala(dev);
    app.post("/users/7", (c) => c.text("static"));
    app.all("/users/:id", (c) => c.text("dyn"));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("every other method");
  });

  it("wildcards and optionals participate in the overlap check", () => {
    const { warns } = warnSink();
    const app = new Keala(dev);
    app.get("/files/*", (c) => c.text("wild"));
    app.post("/files/a.txt", (c) => c.text("static"));
    expect(warns.length).toBe(1);
  });

  it("test and production envs stay silent", () => {
    for (const env of ["test", "production"] as const) {
      const { warns } = warnSink();
      const app = new Keala({ env });
      app.get("/users/:id", (c) => c.text("dyn"));
      app.post("/users/7", (c) => c.text("static"));
      expect(warns.length).toBe(0);
    }
  });

  it("mounted groups warn at mount time on the app router", () => {
    const { warns } = warnSink();
    const app = new Keala(dev);
    app.post("/v1/users/7", (c) => c.text("static"));
    const users = new Router();
    users.get("/:id", (c) => c.text("dyn"));
    app.mount("/v1/users", users);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("/v1/users/:id");
  });

  it("unrelated static and dynamic routes never warn", () => {
    const { warns } = warnSink();
    const app = new Keala(dev);
    app.get("/users/:id", (c) => c.text("dyn"));
    app.post("/pages/about", (c) => c.text("static"));
    app.get("/users/:id/posts/:postId", (c) => c.text("nested"));
    expect(warns.length).toBe(0);
  });
});
