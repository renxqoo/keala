/**
 * Doc-example consistency locks — the shapes shown in README.md,
 * README.zh-CN.md and docs/KEALA-NATIVE-API.md ARE the real API surface
 * (U4 of the native-API migration: return-only responses, functional
 * params, pure-builder redirect).
 */
import { describe, expect, test } from "vitest";
import { Keala, bodyOf } from "../../src/index.ts";
import type { Context } from "../../src/index.ts";

describe("doc examples vs real API", () => {
  test("quick start: return-style sugar and functional params", async () => {
    const app = new Keala();
    app.get("/", (c) => c.text("hello keala"));
    app.get("/users/:id(\\d+)", (c) => c.json({ id: c.params("id") }));
    app.get("/page", (c) => c.html("<b>hi</b>"));
    app.get("/made", (c) => c.text("created", 201, { "x-app": "keala" }));

    let res = await app.handle(new Request("http://localhost/"));
    expect(await res.text()).toBe("hello keala");

    res = await app.handle(new Request("http://localhost/users/42"));
    expect(res.headers.get("content-type")?.startsWith("application/json")).toBe(true);
    expect(await res.json()).toEqual({ id: "42" });

    res = await app.handle(new Request("http://localhost/page"));
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<b>hi</b>");

    res = await app.handle(new Request("http://localhost/made"));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-app")).toBe("keala");
  });

  test("c.params(name) misses read undefined (no bracket/property form)", async () => {
    const app = new Keala();
    app.get("/static", (c) => c.text(String(c.params("id")))); // param not on this route
    app.get("/w/:x?", (c) => c.text(c.params("x") ?? "absent")); // optional may be absent

    let res = await app.handle(new Request("http://localhost/static"));
    expect(await res.text()).toBe("undefined");
    res = await app.handle(new Request("http://localhost/w"));
    expect(await res.text()).toBe("absent");
    res = await app.handle(new Request("http://localhost/w/a"));
    expect(await res.text()).toBe("a");
  });

  test("the retired response accessors are gone from the context surface", async () => {
    const app = new Keala();
    const retired = ["body", "type", "length", "etag", "lastModified", "attachment", "res"];
    app.get("/gone", (c) => {
      const holder = c as unknown as Record<string, unknown>;
      return c.json(retired.map((key) => typeof holder[key]));
    });
    const res = await app.handle(new Request("http://localhost/gone"));
    expect(await res.json()).toEqual(retired.map(() => "undefined"));
  });

  test("c.status is a read-only observation slot", async () => {
    const app = new Keala();
    const seen: number[] = [];
    app.use(async (c, next) => {
      await next();
      seen.push(c.status); // post-next: reads the committed Response's status
    });
    app.get("/draining", (c) => c.text("draining", 503));
    app.get("/assign", (c) => {
      try {
        (c as { status: number }).status = 201; // getter-only prototype accessor
        return c.text("assigned");
      } catch (err) {
        return c.text(err instanceof TypeError ? "type-error" : "other");
      }
    });

    let res = await app.handle(new Request("http://localhost/draining"));
    expect(res.status).toBe(503);
    expect(seen.at(-1)).toBe(503);

    res = await app.handle(new Request("http://localhost/assign"));
    expect(await res.text()).toBe("type-error");
  });

  test("c.redirect is a pure builder — it takes effect only when returned", async () => {
    const app = new Keala();
    app.get("/r", (c) => c.redirect("/login", 301));
    app.get("/discarded", (c) => {
      c.redirect("/elsewhere"); // built and dropped — the context is untouched
    });
    app.get("/bad-code", (c) => {
      try {
        c.redirect("/x", 200);
      } catch (err) {
        return c.text(err instanceof TypeError ? "type-error" : "other");
      }
      return c.text("no-throw");
    });

    let res = await app.handle(new Request("http://localhost/r"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.body).toBe(null); // Location-only empty body

    res = await app.handle(new Request("http://localhost/discarded"));
    expect(res.status).toBe(404); // void chain → built-in 404; the build never landed

    res = await app.handle(new Request("http://localhost/bad-code"));
    expect(await res.text()).toBe("type-error");
  });

  test("setter recipes: full header values replace the deleted setters", async () => {
    const app = new Keala();
    app.get("/file", (c) => {
      c.setHeader("Content-Type", "application/pdf");
      c.setHeader("Content-Length", "5");
      c.setHeader("ETag", '"v1"'); // quotes are manual now
      c.setHeader("Last-Modified", new Date(0).toUTCString());
      c.setHeader("Content-Disposition", 'attachment; filename="report.pdf"');
      return c.text("bytes");
    });
    const res = await app.handle(new Request("http://localhost/file"));
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("etag")).toBe('"v1"');
    expect(res.headers.get("last-modified")).toBe("Thu, 01 Jan 1970 00:00:00 GMT");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
    expect(await res.text()).toBe("bytes");
  });

  test("header writes before and after the return both reach the wire", async () => {
    const app = new Keala();
    app.use(async (c, next) => {
      c.setHeader("X-Early", "1"); // staged → consumed into the built Response
      await next();
      c.setHeader("X-Late", "1"); // post-commit → lands on the committed Response
      c.append("Vary", "Origin");
    });
    app.get("/late", (c) => c.text("ok"));
    const res = await app.handle(new Request("http://localhost/late"));
    expect(res.headers.get("x-early")).toBe("1");
    expect(res.headers.get("x-late")).toBe("1");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("bodyOf without the plugin throws the guidance TypeError", async () => {
    const app = new Keala();
    let threw: unknown;
    app.get("/b", (c) => {
      try {
        bodyOf(c);
      } catch (err) {
        threw = err;
      }
      return c.text("done");
    });
    await app.handle(new Request("http://localhost/b"));
    expect(threw).toBeInstanceOf(TypeError);
    expect((threw as TypeError).message).toContain("createBodyParser");
  });

  test("decorate installs c.db at runtime", async () => {
    const app = new Keala();
    app.decorate("db", { query: () => 42 });
    app.get("/db", (c) => {
      const db = (c as Context & { db: { query(): number } }).db;
      return c.text(String(db.query()));
    });
    const res = await app.handle(new Request("http://localhost/db"));
    expect(await res.text()).toBe("42");
  });
});
