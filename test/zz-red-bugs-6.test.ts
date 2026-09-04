/**
 * zz-red-bugs-6 — FINAL verification of reported findings. These assertions
 * encode the CORRECT expected behavior; failures are the bugs being reported.
 */
import { describe, expect, it } from "vitest";
import { Keala } from "../src/index.ts";
import { Router } from "../src/router/group.ts";

const hit = async (
  app: InstanceType<typeof Keala>,
  path: string,
  init?: RequestInit,
): Promise<Response> => app.handle(new Request(`http://localhost${path}`, init));

describe("BUG-1: redirect() registration range vs effective redirect statuses", () => {
  it("app.redirect 306 is silently coerced to 302 on the wire", async () => {
    const app = new Keala({ env: "test" });
    app.redirect("/a", "/b", 306);
    const res = await hit(app, "/a");
    expect([res.status, res.headers.get("location")]).toEqual([306, "/b"]);
  });

  it("app.redirect 304 is silently coerced to 302 on the wire", async () => {
    const app = new Keala({ env: "test" });
    app.redirect("/a", "/b", 304);
    const res = await hit(app, "/a");
    expect(res.status).toBe(304);
  });

  it("Router.redirect 306 is silently coerced to 302 on the wire", async () => {
    const app = new Keala({ env: "test" });
    const r = new Router();
    r.redirect("/a", "/b", 306);
    app.mount("/", r);
    const res = await hit(app, "/a");
    expect(res.status).toBe(306);
  });

  it("contrast: c.redirect(target, 306) keeps 306 (explicit-code path)", async () => {
    const app = new Keala({ env: "test" });
    app.get("/a", (c) => {
      c.redirect("/b", 306);
    });
    const res = await hit(app, "/a");
    expect(res.status).toBe(306);
  });
});

describe("BUG-2: error-mapper takeover drops staged Set-Cookie when it sets its own", () => {
  it("staged cookie + takeover cookie both ship (join, not replace)", async () => {
    const app = new Keala({ env: "test" });
    app.use((c, next) => {
      c.cookies.set("pre", "1");
      return next();
    });
    app.onError(
      () =>
        new Response("boom", {
          status: 500,
          headers: { "set-cookie": "post=2; Path=/" },
        }),
    );
    app.get("/", () => {
      throw new Error("x");
    });
    const res = await hit(app, "/");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((line) => line.startsWith("pre="))).toBe(true);
    expect(cookies.some((line) => line.startsWith("post="))).toBe(true);
  });

  it("contrast: builtin path keeps the staged cookie", async () => {
    const app = new Keala({ env: "test" });
    app.use((c, next) => {
      c.cookies.set("pre", "1");
      return next();
    });
    app.get("/", () => {
      throw new Error("x");
    });
    const res = await hit(app, "/");
    expect(res.headers.getSetCookie().some((line) => line.startsWith("pre="))).toBe(true);
  });
});

describe("BUG-3: c.body = <Response> type-checks but silently serializes {}", () => {
  it("assigning a web Response produces a JSON body, not the Response's content", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.body = new Response("real-body", { status: 201, headers: { "x-r": "1" } });
    });
    const res = await hit(app, "/");
    // Expected under the documented removal: a loud error. Actual: silent
    // 200 with JSON "{}" — status and headers of the assigned Response are
    // dropped even though the type permits the assignment.
    expect([res.status, await res.text(), res.headers.get("x-r")]).toEqual([
      "201-or-error",
      "real-body-or-error",
      "1-or-error",
    ]);
  });
});
