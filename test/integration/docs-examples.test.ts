/**
 * UX review red tests — verify doc examples against the real API surface.
 * Read-only investigation; not meant to be merged.
 */
import { describe, expect, test } from "vitest";
import { Keala } from "../../src/index.ts";
import type { Context } from "../../src/index.ts";

const app = new Keala();

describe("README examples vs real API", () => {
  test("c.get was retired (README.zh-CN still documents it)", async () => {
    app.get("/h", (c) => c.text(c.header("x-a")));
    const res = await app.handle(new Request("http://localhost/h", { headers: { "x-a": "1" } }));
    expect(await res.text()).toBe("1");
    // The retired alias:
    const probe = app.get("/g", (c) => {
      const holder = c as Context & { get?: (f: string) => string };
      return c.text(String(typeof holder.get));
    });
    expect(probe).toBeTruthy();
    const res2 = await app.handle(new Request("http://localhost/g"));
    expect(await res2.text()).toBe("undefined");
  });

  test("bodyOf without the plugin throws the guidance TypeError", async () => {
    const { bodyOf } = await import("../../src/index.ts");
    const app2 = new Keala();
    let threw: unknown;
    app2.get("/b", (c) => {
      try {
        bodyOf(c);
      } catch (err) {
        threw = err;
      }
      return c.text("done");
    });
    await app2.handle(new Request("http://localhost/b"));
    expect(threw).toBeInstanceOf(TypeError);
    expect((threw as TypeError).message).toContain("createBodyParser");
  });

  test("decorate installs c.db at runtime", async () => {
    const app3 = new Keala();
    app3.decorate("db", { query: () => 42 });
    app3.get("/db", (c) => {
      const db = (c as Context & { db: { query(): number } }).db;
      return c.text(String(db.query()));
    });
    const res = await app3.handle(new Request("http://localhost/db"));
    expect(await res.text()).toBe("42");
  });
});
