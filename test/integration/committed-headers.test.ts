/**
 * The 0.7 committed-header contract: after a Response commits, header
 * writes (setHeader/append/remove/type/length/etag/…) land DIRECTLY on the
 * committed Response's headers — one path, no rebuild machinery. Body and
 * status writes throw. A newer commit (an outer middleware returning
 * another Response) wins outright: inter-commit writes belonged to the
 * response they were applied to.
 */
import { describe, expect, it } from "vitest";
import { Keala } from "../../src/core/app.ts";
import type { Context } from "../../src/core/context/context.ts";

const request = (path = "/"): Request => new Request(`http://localhost${path}`);

describe("0.7 committed header contract", () => {
  it("applies a late ordinary set to the committed Response without replacing it", async () => {
    const app = new Keala({ env: "production" });
    let committed: Response | undefined;
    let observed = false;

    app.use(async (c, next) => {
      await next();
      c.setHeader("X-Late", "one");
      observed = c.has("x-late") && c.resHeader("X-Late") === "one";
    });
    app.get("/", (c) => (committed = c.text("hello")));

    const response = await app.handle(request());
    expect(response).toBe(committed);
    expect(observed).toBe(true);
    expect(response.headers.get("x-late")).toBe("one");
    // Node's undici stamps string bodies at construction; Bun defers the
    // text/plain inference to serve time — either way the post-commit write
    // did not disturb the body's implicit type.
    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType === "" || /^text\/plain/i.test(contentType)).toBe(true);
    expect(await response.text()).toBe("hello");
  });

  it("applies a late ordinary remove without replacing the committed Response", async () => {
    const app = new Keala({ env: "production" });
    let committed: Response | undefined;

    app.use(async (c, next) => {
      await next();
      c.remove("X-Remove");
      expect(c.has("x-remove")).toBe(false);
      expect(c.resHeader("x-remove")).toBe("");
    });
    app.get(
      "/",
      () =>
        (committed = new Response("hello", {
          headers: { "x-remove": "old", "x-keep": "yes" },
        })),
    );

    const response = await app.handle(request());
    expect(response).toBe(committed);
    expect(response.headers.get("x-remove")).toBeNull();
    expect(response.headers.get("x-keep")).toBe("yes");
  });

  it("keeps late appends observable while retaining Response identity", async () => {
    const app = new Keala({ env: "production" });
    let committed: Response | undefined;

    app.use(async (c, next) => {
      await next();
      c.append("X-List", "two");
      c.append("Vary", "accept-encoding");
      expect(c.resHeader("x-list")).toBe("one, two");
      expect(c.resHeader("vary")).toBe("accept, accept-encoding");
    });
    app.get(
      "/",
      () =>
        (committed = new Response("hello", {
          headers: { "x-list": "one", vary: "accept" },
        })),
    );

    const response = await app.handle(request());
    expect(response).toBe(committed);
    expect(response.headers.get("x-list")).toBe("one, two");
    expect(response.headers.get("vary")).toBe("accept, accept-encoding");
  });

  it("a post-commit SET carries onto a newer commit (idempotent record mirror)", async () => {
    const app = new Keala({ env: "production" });

    app.use(async (c, next) => {
      await next();
      c.setHeader("X-Carry", "yes");
      return new Response("outer", { headers: { "x-outer": "yes" } });
    });
    app.get("/", (c) => c.text("inner"));

    const response = await app.handle(request());
    expect(response.headers.get("x-outer")).toBe("yes");
    expect(response.headers.get("x-carry")).toBe("yes");
    expect(await response.text()).toBe("outer");
  });

  it("a newer commit sees removals as they were at its own construction time", async () => {
    const app = new Keala({ env: "production" });

    app.use(async (c, next) => {
      await next();
      c.remove("X-Remove");
      return new Response("outer", { headers: { "x-remove": "outer", "x-keep": "yes" } });
    });
    app.get("/", () => new Response("inner", { headers: { "x-remove": "inner" } }));

    const response = await app.handle(request());
    expect(response.headers.get("x-remove")).toBe("outer");
    expect(response.headers.get("x-keep")).toBe("yes");
  });

  it("removing c.type after commit removes the committed Content-Type", async () => {
    const app = new Keala({ env: "production" });

    app.use(async (c, next) => {
      await next();
      c.type = null;
    });
    app.get("/", () => new Response("hello", { headers: { "content-type": "text/custom" } }));

    const response = await app.handle(request());
    expect(response.headers.get("content-type")).toBeNull();
  });

  it.skipIf(typeof Bun !== "undefined")(
    "a post-commit write against an immutable guard throws loudly (undici)",
    async () => {
      const app = new Keala({ env: "production" });
      const fetched = await fetch("data:text/plain,hello");
      const thrown: unknown[] = [];

      app.use(async (c, next) => {
        await next();
        try {
          c.setHeader("X-Late", "yes");
        } catch (error) {
          thrown.push(error);
        }
      });
      app.get("/", () => fetched);

      const response = await app.handle(request());
      expect(thrown[0]).toBeInstanceOf(TypeError);
      expect((thrown[0] as Error).message).toMatch(/immutable/);
      expect(response.headers.get("x-late")).toBeNull();
      expect(await response.text()).toBe("hello");
    },
  );

  it("post-commit Set-Cookie: setHeader replaces, append and the facade join", async () => {
    const app = new Keala({ env: "production" });
    let committed: Response | undefined;

    app.use(async (c, next) => {
      await next();
      c.setHeader("Set-Cookie", "late=1; Path=/");
      c.setHeader("Content-Type", "application/custom");
      c.append("X-Many", ["two", "three"]);
    });
    app.get(
      "/",
      () =>
        (committed = new Response("hello", {
          headers: { "set-cookie": "early=1; Path=/", "x-many": "one" },
        })),
    );

    const response = await app.handle(request());
    expect(response).toBe(committed);
    // A SET is a set: the whole header slot is replaced.
    expect(response.headers.getSetCookie()).toEqual(["late=1; Path=/"]);
    expect(response.headers.get("content-type")).toBe("application/custom");
    expect(response.headers.get("x-many")).toBe("one, two, three");
  });

  it("a post-commit body write throws instead of rebuilding", async () => {
    const app = new Keala({ env: "production" });
    const thrown: unknown[] = [];

    app.use(async (c, next) => {
      await next();
      c.setHeader("X-Fast", "yes");
      try {
        c.body = "replacement";
      } catch (error) {
        thrown.push(error);
      }
    });
    app.get("/", () => new Response("original", { headers: { "x-original": "yes" } }));

    const response = await app.handle(request());
    expect(thrown[0]).toBeInstanceOf(TypeError);
    expect((thrown[0] as Error).message).toMatch(/already committed/);
    expect(response.headers.get("x-fast")).toBe("yes");
    expect(await response.text()).toBe("original");
  });

  it("a post-commit status write throws instead of rebuilding", async () => {
    const app = new Keala({ env: "production" });
    const thrown: unknown[] = [];

    app.use(async (c, next) => {
      await next();
      try {
        c.status = 204;
      } catch (error) {
        thrown.push(error);
      }
    });
    app.get("/", (c) => c.text("hello"));

    const response = await app.handle(request());
    expect(thrown[0]).toBeInstanceOf(TypeError);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
  });

  it("does not skip a cookie written through a facade created before commit", async () => {
    const app = new Keala({ env: "production" });

    app.use(async (c, next) => {
      const cookies = c.cookies;
      await next();
      c.setHeader("X-Fast", "yes");
      cookies.set("session", "late", { secure: false });
    });
    app.get("/", (c) => c.text("hello"));

    const response = await app.handle(request());
    expect(response.headers.get("x-fast")).toBe("yes");
    expect(response.headers.getSetCookie()).toEqual([expect.stringContaining("session=late")]);
  });

  it("headers staged BEFORE the commit ride onto the committed Response", async () => {
    const app = new Keala({ env: "production" });

    app.get("/", (c) => {
      c.setHeader("X-Staged", "yes");
      return new Response("built", { headers: { "x-own": "yes" } });
    });

    const response = await app.handle(request());
    expect(response.headers.get("x-staged")).toBe("yes");
    expect(response.headers.get("x-own")).toBe("yes");
    expect(await response.text()).toBe("built");
  });

  it.each([
    ["set last-write-wins", [(c: Context) => c.setHeader("X-Base", "two")]],
    ["remove", [(c: Context) => c.remove("X-Base")]],
    [
      "remove then set",
      [(c: Context) => c.remove("X-Base"), (c: Context) => c.setHeader("X-Base", "three")],
    ],
    [
      "set then remove",
      [(c: Context) => c.setHeader("X-New", "two"), (c: Context) => c.remove("X-New")],
    ],
    ["append", [(c: Context) => c.append("X-Base", "two")]],
    [
      "ordinary then singleton",
      [
        (c: Context) => c.setHeader("X-New", "two"),
        (c: Context) => c.setHeader("Content-Type", "application/custom"),
      ],
    ],
    [
      "ordinary then cookie",
      [
        (c: Context) => c.setHeader("X-New", "two"),
        (c: Context) => c.cookies.set("late", "1", { secure: false }),
      ],
    ],
  ] satisfies [string, ((c: Context) => void)[]][])(
    "applies post-commit %s in place on the committed Response",
    async (_name, operations) => {
      const app = new Keala({ env: "production" });
      let committed: Response | undefined;

      app.use(async (c, next) => {
        await next();
        for (const operation of operations) operation(c);
      });
      app.get(
        "/",
        () =>
          (committed = new Response("original", {
            headers: {
              "content-type": "text/plain",
              "set-cookie": "early=1; Path=/",
              vary: "accept",
              "x-base": "one",
            },
          })),
      );

      const response = await app.handle(request());
      expect(response).toBe(committed);
      expect(await response.text()).toBe("original");
    },
  );
});

describe("same-name staged/returned header precedence (§2.3-1)", () => {
  it("staged headers override a returned Response's same-name header", async () => {
    // The generic rule: staged writes win over headers the handler's
    // returned Response carries (respond.ts applyStagedHeaders does
    // delete+set per name).
    const app = new Keala({ env: "test" });
    app.get("/x", (c) => {
      c.setHeader("X-Duel", "staged");
      return new Response("ok", { headers: { "x-duel": "returned" } });
    });
    const res = await app.handle(new Request("http://localhost:3000/x"));
    expect(res.headers.get("x-duel")).toBe("staged");
  });

  it("a staged Location overrides the redirect target (U3a priority flip)", async () => {
    // The staged redirect form made redirect the LAST Location writer; the
    // U3a return form is subject to §2.3-1 like every other returned header —
    // an explicitly staged Location wins over c.redirect's target. The
    // status still comes from the redirect (the staged record carries no
    // status of its own).
    const app = new Keala({ env: "test" });
    app.get("/r", (c) => {
      c.setHeader("Location", "/staged");
      return c.redirect("/next");
    });
    const res = await app.handle(new Request("http://localhost:3000/r"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/staged");
  });
});
