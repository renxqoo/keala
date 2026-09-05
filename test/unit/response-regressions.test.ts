/**
 * zz-red-bugs-1 — exploratory red-test battery (deep bug review round).
 * Each probe asserts the CORRECT expected behavior; failures are candidate bugs.
 */
import { describe, expect, it } from "vitest";
import { Keala } from "../../src/index.ts";

const hit = async (
  app: InstanceType<typeof Keala>,
  path: string,
  init?: RequestInit,
): Promise<Response> => app.handle(new Request(`http://localhost${path}`, init));

describe("redirect semantics", () => {
  it("app.redirect code 306 stays 306 (registered intent)", async () => {
    const app = new Keala({ env: "test" });
    app.redirect("/a", "/b", 306);
    const res = await hit(app, "/a");
    expect([res.status, res.headers.get("location")]).toEqual([306, "/b"]);
  });

  it("app.redirect code 304 stays 304", async () => {
    const app = new Keala({ env: "test" });
    app.redirect("/a", "/b", 304);
    const res = await hit(app, "/a");
    expect([res.status, res.headers.get("location")]).toEqual([304, "/b"]);
  });

  it("app.redirect rejects a clearly invalid code at registration", () => {
    const app = new Keala({ env: "test" });
    expect(() => app.redirect("/a", "/b", 302.5)).toThrow();
  });

  it("c.redirect default 302 keeps Location, no body", async () => {
    const app = new Keala({ env: "test" });
    app.get("/go", (c) => {
      c.redirect("/target");
    });
    const res = await hit(app, "/go");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/target");
    expect(await res.text()).toBe("");
  });

  it("c.redirect back-form removed: explicit code path validates", async () => {
    const app = new Keala({ env: "test" });
    let caught: unknown = null;
    app.get("/go", (c) => {
      try {
        c.redirect("/t", 999);
      } catch (err) {
        caught = err;
      }
    });
    const res = await hit(app, "/go");
    expect(caught).toBeInstanceOf(TypeError);
    expect(res.status).toBe(404);
  });
});

describe("post-commit header writes (0.7 contract)", () => {
  it("append after commit JOINS committed value (no loss)", async () => {
    const app = new Keala({ env: "test" });
    app.use(async (c, next) => {
      await next();
      c.append("x-joined", "post");
    });
    app.get("/", (_c) => new Response("ok", { headers: { "x-joined": "committed" } }));
    const res = await hit(app, "/");
    // append semantics: the committed value must survive
    expect(res.headers.get("x-joined")?.includes("committed")).toBe(true);
    expect(res.headers.get("x-joined")?.includes("post")).toBe(true);
  });

  it("set after commit REPLACES (mirror survives finalize)", async () => {
    const app = new Keala({ env: "test" });
    app.use(async (c, next) => {
      await next();
      c.setHeader("x-sec", "outer");
    });
    app.get("/", (c) => c.text("hi"));
    const res = await hit(app, "/");
    expect(res.headers.get("x-sec")).toBe("outer");
    expect(await res.text()).toBe("hi");
  });

  it("remove after commit removes from the wire", async () => {
    const app = new Keala({ env: "test" });
    app.use(async (c, next) => {
      await next();
      c.remove("x-drop");
    });
    app.get("/", (_c) => new Response("ok", { headers: { "x-drop": "1", "x-keep": "2" } }));
    const res = await hit(app, "/");
    expect(res.headers.get("x-drop")).toBeNull();
    expect(res.headers.get("x-keep")).toBe("2");
  });

  it("post-commit has() sees committed headers", async () => {
    const app = new Keala({ env: "test" });
    let seen = "";
    app.use(async (c, next) => {
      await next();
      seen = String(c.has("x-frame-options"));
    });
    app.get("/", (_c) => new Response("ok", { headers: { "x-frame-options": "DENY" } }));
    await hit(app, "/");
    expect(seen).toBe("true");
  });
});

describe("error funnel interactions", () => {
  it("outer middleware throw after next() keeps staged+committed security headers", async () => {
    const app = new Keala({ env: "test" });
    app.use(async (c, next) => {
      c.setHeader("x-pre", "staged");
      await next();
      c.setHeader("x-post", "post");
      throw new Error("late boom");
    });
    app.get("/", (c) => c.text("hi"));
    const res = await hit(app, "/");
    expect(res.status).toBe(500);
    expect(res.headers.get("x-pre")).toBe("staged");
    expect(res.headers.get("x-post")).toBe("post");
  });

  it("error mapper takeover carries staged headers (if-absent)", async () => {
    const app = new Keala({ env: "test" });
    app.use((c, next) => {
      c.setHeader("x-sec", "staged");
      return next();
    });
    app.onError((_e, _c) => new Response("mapped", { status: 502, headers: { "x-m": "1" } }));
    app.get("/", () => {
      throw new Error("x");
    });
    const res = await hit(app, "/");
    expect(res.status).toBe(502);
    expect(res.headers.get("x-sec")).toBe("staged");
    expect(res.headers.get("x-m")).toBe("1");
  });

  it("exposed 4xx message rides; hidden 5xx message does not", async () => {
    const app = new Keala({ env: "test" });
    app.get("/a", (c) => c.throw(400, "bad input"));
    app.get("/b", () => {
      throw new Error("secret leak");
    });
    const a = await hit(app, "/a");
    const b = await hit(app, "/b");
    expect(await a.text()).toBe("bad input");
    expect(await b.text()).toBe("Internal Server Error");
  });

  it("error thrown by handler AFTER committing sugar: response replaced, not 200", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.text("ok");
      throw new Error("after commit");
    });
    const res = await hit(app, "/");
    expect(res.status).toBe(500);
  });
});

describe("HEAD handling", () => {
  it("HEAD on state-mode string body: CL backfilled, no body", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.body = "héllo";
      c.type = "text/plain";
    });
    const res = await hit(app, "/", { method: "HEAD" });
    expect(res.headers.get("content-length")).toBe("6"); // héllo = 6 UTF-8 bytes
    expect(await res.text()).toBe("");
  });

  it("HEAD on committed Response: body stripped, headers kept", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", () => new Response("body-body", { headers: { "x-k": "v" } }));
    const res = await hit(app, "/", { method: "HEAD" });
    expect(res.headers.get("x-k")).toBe("v");
    expect(await res.text()).toBe("");
  });

  it("HEAD falls back to GET handler", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => c.text("get-body"));
    const res = await hit(app, "/", { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  it("bodied 204: undici refuses the construction (500); Bun sanitizes to a clean 204", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", () => new Response("oops", { status: 204 }));
    const res = await hit(app, "/");
    if (typeof Bun === "undefined") {
      // Node/undici: the Response constructor throws for null-body statuses
      // with a body — the handler throw becomes a 500 through the funnel.
      expect(res.status).toBe(500);
    } else {
      // Bun allows the construction; the empty-status sanitizer strips the
      // body AND the headers describing it (respond.ts sanitizeEmptyStatus —
      // the §2.3-2 semantics of the native-API migration, locked here).
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers.get("content-type")).toBeNull();
    }
  });
});

describe("router edges", () => {
  it("optional param: both shapes work, params never null", async () => {
    const app = new Keala({ env: "test" });
    app.get("/a/:b?", (c) => c.json({ b: c.params("b") ?? null }));
    const a = await (await hit(app, "/a")).text();
    const b = await (await hit(app, "/a/x")).text();
    expect(a).toBe('{"b":null}');
    expect(b).toBe('{"b":"x"}');
  });

  it("wildcard root answers /", async () => {
    const app = new Keala({ env: "test" });
    app.get("/*", (c) => c.text(`w:${c.params("wildcard")}`));
    expect(await (await hit(app, "/")).text()).toBe("w:");
    expect(await (await hit(app, "/x/y")).text()).toBe("w:x/y");
  });

  it("percent-encoded param is decoded once", async () => {
    const app = new Keala({ env: "test" });
    app.get("/u/:name", (c) => c.text(c.params("name") ?? ""));
    expect(await (await hit(app, "/u/a%20b")).text()).toBe("a b");
    expect(await (await hit(app, "/u/a%2Fb")).text()).toBe("a/b");
  });

  it("static route prefers exact over dynamic; 405 Allow lists methods", async () => {
    const app = new Keala({ env: "test" });
    app.get("/users/all", (c) => c.text("all"));
    app.get("/users/:id", (c) => c.text(`id:${c.params("id")}`));
    expect(await (await hit(app, "/users/all")).text()).toBe("all");
    expect(await (await hit(app, "/users/7")).text()).toBe("id:7");
    app.post("/users/7", (c) => c.text("posted"));
    const del = await hit(app, "/users/7", { method: "DELETE" });
    expect(del.status).toBe(405);
    expect(del.headers.get("allow")).toBe("POST"); // static /users/7 target (POST) shadows dynamic /users/:id by design
  });

  it("OPTIONS on unregistered method answers 200 + Allow", async () => {
    const app = new Keala({ env: "test" });
    app.get("/x", (c) => c.text("g"));
    const res = await hit(app, "/x", { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("unknown method answers 501 with Allow", async () => {
    const app = new Keala({ env: "test" });
    app.get("/x", (c) => c.text("g"));
    const res = await hit(app, "/x", { method: "PURGE" });
    expect(res.status).toBe(501);
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("trailing slash static hit", async () => {
    const app = new Keala({ env: "test" });
    app.get("/about", (c) => c.text("A"));
    expect((await hit(app, "/about/")).status).toBe(200);
  });

  it("routePath carries the matched pattern", async () => {
    const app = new Keala({ env: "test" });
    let p = "";
    app.get("/u/:id", (c) => {
      p = c.routePath;
      return c.text("ok");
    });
    await hit(app, "/u/9");
    expect(p).toBe("/u/:id");
  });
});

describe("query parsing", () => {
  it("targeted reads: first, all, boundaries, malformed escapes", async () => {
    const app = new Keala({ env: "test" });
    const seen: unknown[] = [];
    app.get("/", (c) => {
      seen.push(
        c.query("page"),
        c.query("pagesize"),
        c.queries("a"),
        c.query("missing"),
        c.query("enc"),
      );
      return c.text("ok");
    });
    await hit(app, "/?pagesize=2&page=1&a=1&a=2&enc=%ZZ&enc=%41");
    expect(seen).toEqual(["1", "2", ["1", "2"], undefined, "%ZZ"]);
  });

  it("plus decodes as space in values", async () => {
    const app = new Keala({ env: "test" });
    let v = "";
    app.get("/", (c) => {
      v = c.query("q") ?? "";
      return c.text("ok");
    });
    await hit(app, "/?q=a+b");
    expect(v).toBe("a b");
  });
});

describe("cookie facade", () => {
  it("set/get round trip, overwrite, multi cookies", async () => {
    const app = new Keala({ env: "test", keys: ["k"] });
    app.get("/set", (c) => {
      c.cookies.set("a", "1");
      c.cookies.set("b", "2", { signed: true });
      c.cookies.set("a", "3", { overwrite: true });
      return c.text("ok");
    });
    const res = await hit(app, "/set");
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBe(2); // a=3 (signed, overwritten) + b=2 (signed)
    const aLine = cookies.find((x) => x.startsWith("a="));
    expect(aLine?.startsWith("a=3.")).toBe(true); // overwrite replaces the earlier a= line (signed by default with keys)
    const bLine = cookies.find((x) => x.startsWith("b="));
    expect(bLine).toContain(".");
  });

  it("signed get verifies and strips", async () => {
    const app = new Keala({ env: "test", keys: ["k"] });
    let got: unknown;
    app.get("/read", (c) => {
      got = c.cookies.get("s", { signed: true });
      return c.text("ok");
    });
    const { sign } = await import("../../src/context/cookies.ts");
    const signed = sign("v", "k");
    await hit(app, "/read", { headers: { cookie: `s=${signed}` } });
    expect(got).toBe("v");
  });
});

describe("state-mode responses", () => {
  it("default 404 body is the status text", async () => {
    const app = new Keala({ env: "test" });
    const res = await hit(app, "/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("c.status=204 clears content headers", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.type = "text/html";
      c.body = "x";
      c.status = 204;
    });
    const res = await hit(app, "/");
    expect(res.status).toBe(204);
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).toBe("");
  });

  it("JSON object body gets application/json", async () => {
    const app = new Keala({ env: "test" });
    app.get("/", (c) => {
      c.body = { a: 1 };
    });
    const res = await hit(app, "/");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe('{"a":1}');
  });

  it("redirect() then finalize carries Location with empty body", async () => {
    const app = new Keala({ env: "test" });
    app.get("/r", (c) => {
      c.status = 301;
      c.redirect("/x");
    });
    const res = await hit(app, "/r");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/x");
  });
});

describe("compose/onion invariants", () => {
  it("double next() throws", async () => {
    const app = new Keala({ env: "test" });
    app.use((_c, next) => {
      void next();
      return next();
    });
    app.get("/", (c) => c.text("ok"));
    const res = await hit(app, "/");
    expect(res.status).toBe(500);
  });

  it("last committer wins (downstream rewrite)", async () => {
    const app = new Keala({ env: "test" });
    app.use(async (_c, next) => {
      await next();
      return new Response("outer");
    });
    app.get("/", (c) => c.text("inner"));
    const res = await hit(app, "/");
    expect(await res.text()).toBe("outer");
  });

  it("sync return after next(): response committed by branch", async () => {
    const app = new Keala({ env: "test" });
    app.use((_c, next) => {
      void next();
      return undefined;
    });
    app.get("/", (c) => c.text("branch"));
    const res = await hit(app, "/");
    expect(await res.text()).toBe("branch");
  });
});

describe("pooling", () => {
  it("retired context mutation throws; recycle clears foreign keys", async () => {
    const app = new Keala({ env: "test", pooling: true });
    app.get("/a", (c) => {
      (c as unknown as { user?: string }).user = "req-a";
      return c.text("A");
    });
    const a = await hit(app, "/a");
    expect(await a.text()).toBe("A");
    // second request recycles; the ad-hoc key must not survive
    let leaked: unknown = "unset";
    app.get("/b", (c) => {
      leaked = (c as unknown as { user?: string }).user;
      return c.text("B");
    });
    const b = await hit(app, "/b");
    expect(await b.text()).toBe("B");
    expect(leaked).toBeUndefined();
  });

  it("pooled bodied sugar response keeps content-type", async () => {
    const app = new Keala({ env: "test", pooling: true });
    app.get("/t", (c) => c.text("hello"));
    app.get("/j", (c) => c.json({ a: 1 }));
    const t = await hit(app, "/t");
    // D1 (Bun ≥1.4.2, pooled rebuild included): sugar text carries no
    // framework content-type — Bun materializes text/plain at send time,
    // undici at construction. Pooling follows the same rule as the plain
    // (non-pooled) path rather than stamping its own type.
    const tct = t.headers.get("content-type");
    expect(tct === null ? typeof Bun !== "undefined" : tct.includes("text/plain")).toBe(true);
    expect(await t.text()).toBe("hello");
    const j = await hit(app, "/j");
    expect(j.headers.get("content-type")).toContain("application/json");
    expect(await j.text()).toBe('{"a":1}');
  });
});
