import { describe, expect, it } from "vitest";

import { Keala } from "../../src/index.ts";

/**
 * U3c migration: the response setter family (c.body=/c.status=(write)/
 * c.type/c.length/c.etag/c.lastModified/c.attachment and the staged reads
 * c.body/c.type/c.etag/c.lastModified/c.res) is gone. Responses are committed
 * by RETURN — c.text/c.json/c.html or a hand-built Response. Tests that
 * locked the deleted setters' own semantics (type expansion, etag
 * auto-quoting, attachment basename/RFC5987, length coercion, the staged
 * null-body/redirect-status slots) were deleted — see the migration report.
 */

const makeApp = () => new Keala({ env: "test" });

describe("response facade (flat context)", () => {
  it("starts as 404 with no body", async () => {
    const app = makeApp();
    app.use(async (c) => {
      expect(c.status).toBe(404);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("validates status codes (U3c: the sugar path delegates to the Response constructor)", async () => {
    const app = makeApp();
    app.use(async (c) => {
      expect(() => c.text("x", 700)).toThrow(RangeError);
      return c.text("Created", 201);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(201);
  });

  it("delivers string bodies verbatim with a text content-type (markup sniffing removed)", async () => {
    // D1 divergence: a markup string is NOT sniffed to text/html — c.text
    // always answers text/plain.
    const app = makeApp();
    let sawType = "";
    app.use(async (c, next) => {
      await next();
      sawType = c.resHeader("Content-Type");
    });
    app.use(async (c) => {
      return c.text("<h1>hello</h1>");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect((sawType ?? "").startsWith("text/plain") || sawType === "").toBe(true);
    expect(await res.text()).toBe("<h1>hello</h1>");
    const htmlType = res.headers.get("content-type") ?? "";
    expect(htmlType === "" || htmlType.startsWith("text/plain")).toBe(true);

    const plain = makeApp();
    plain.use(async (c) => {
      return c.text("plain words");
    });
    const plainRes = await plain.handle(new Request("http://localhost:3000/"));
    const plainType = plainRes.headers.get("content-type") ?? "";
    expect(plainType === "" || plainType.startsWith("text/plain")).toBe(true);
  });

  it("JSON-serializes object bodies via Response.json", async () => {
    const app = makeApp();
    app.use(async (c) => {
      return c.json({ users: [1, 2, 3] });
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect((res.headers.get("content-type") ?? "").split(";")[0]).toBe("application/json");
    expect(await res.json()).toEqual({ users: [1, 2, 3] });
  });

  it("supports binary bodies", async () => {
    const app = makeApp();
    app.use(async () => {
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    // D1: no octet-stream sniffing — the body passes through untouched.
    expect(res.headers.get("content-type")).toBe(null);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("supports stream bodies", async () => {
    const app = makeApp();
    app.use(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode("chunked"));
            controller.close();
          },
        }),
      );
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(await res.text()).toBe("chunked");
  });

  // U3c deletion: "null body maps to 204 (or keeps empty statuses)" locked
  // the staged `c.body = null` slot. The empty-status contract now lives in
  // the sugar path — locked below ("strips content headers for 204/304") and
  // in app-runtime-locks ("sugar: 304 keeps validators/cookies...").

  it("keeps an explicit status when body is set", async () => {
    const app = makeApp();
    app.use(async (c) => {
      return c.json({ ok: true }, 201);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(201);
  });

  it("strips content headers for 204/304", async () => {
    const app = makeApp();
    app.use(async (c) => {
      return c.text("will be dropped", 204);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(204);
    expect(res.headers.get("content-type")).toBe(null);
    expect(res.headers.get("content-length")).toBe(null);
    expect(await res.text()).toBe("");
  });

  // U3c: the state-mode HEAD backfill (and its bare-fast-path bug) is gone —
  // the sugar path builds the HEAD view AT CONSTRUCTION, so Content-Length
  // reaches the wire even with no other header staged.
  it("drops the body for HEAD requests (sugar builds the HEAD view)", async () => {
    const app = makeApp();
    app.use(async (c) => {
      return c.text("body-content");
    });
    const res = await app.handle(new Request("http://localhost:3000/", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("12");
    expect(await res.text()).toBe("");
  });

  it("set/append/remove header operations", async () => {
    const app = makeApp();
    app.use(async (c) => {
      c.setHeader("X-One", "1");
      c.setHeader("x-one", "override");
      c.append("X-Many", "a");
      c.append("X-Many", "b");
      c.append("Vary", "Origin");
      c.append("Vary", "Accept");
      c.remove("x-one");
      return c.text("ok");
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.headers.get("x-one")).toBe(null);
    expect(res.headers.get("x-many")).toBe("a, b");
    expect(res.headers.get("vary")).toBe("Origin, Accept");
  });

  it("rejects invalid header field names and values", async () => {
    const app = makeApp();
    app.use(async (c) => {
      expect(() => c.setHeader("Bad Name", "v")).toThrow(TypeError);
      expect(() => c.setHeader("X-Ok", "v\r\nInjected: 1")).toThrow(TypeError);
      return c.text("ok");
    });
    await app.handle(new Request("http://localhost:3000/"));
  });

  // U3c deletions (deleted-API semantics — the setters' own behavior):
  //  - "type setter and getter" — c.type write/read pair, param-stripping getter
  //  - "etag quoting and lastModified validation" — auto-quoting + Date checks
  //  - "etag removal on empty value" — the setter's empty-string removal slot
  //  - "keeps an explicit redirect status" — the staged `c.status = 3xx` slot
  //    feeding c.redirect's default code; the explicit-code form is locked by
  //    the redirect tests below
  //  - "attachment ..." ×3 — basename/MIME-inference/RFC5987 fallback
  //  - "length setter coerces numbers" — the setter's numeric coercion

  it("redirect sets Location with an empty body (0.7 adjudication)", async () => {
    const app = makeApp();
    app.use(async (c) => {
      return c.redirect("/target?x=1");
    });
    const res = await app.handle(
      new Request("http://localhost:3000/", {
        headers: { Accept: "text/html" },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/target?x=1");
    expect(res.headers.get("content-type")).toBe(null);
    expect(await res.text()).toBe("");
  });

  it("redirect accepts an explicit 3xx code and rejects anything else eagerly", async () => {
    const app = makeApp();
    app.use(async (c) => {
      return c.redirect("/gone", 301);
    });
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/gone");

    const invalid = makeApp();
    invalid.use(async (c) => {
      expect(() => c.redirect("/x", 200)).toThrow(/3xx/);
      expect(() => c.redirect("/x", 404)).toThrow(/3xx/);
      expect(() => c.redirect("/x", 302.5)).toThrow(/3xx/);
      return c.text("ok");
    });
    await invalid.handle(new Request("http://localhost:3000/"));
  });

  it("redirect after a commit is a harmless pure build (U3a: no throw, no effect unless returned)", async () => {
    const app = new Keala({ env: "production" });
    let built: Response | undefined;
    app.use(async (c, next) => {
      await next();
      built = c.redirect("/late"); // built, NOT returned — the commit survives
    });
    app.get("/", (c) => c.text("committed"));
    const res = await app.handle(new Request("http://localhost:3000/"));
    expect(built).toBeInstanceOf(Response);
    expect(built?.status).toBe(302);
    expect(res.headers.get("location")).toBe(null);
    expect(await res.text()).toBe("committed");
  });
});
