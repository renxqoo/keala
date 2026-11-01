import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { Kernel, Reply, json } from "../../experimental/kernel/kernel.ts";
import { type Params, type TextResult } from "../../experimental/kernel/reply.ts";

const request = (path = "/", method = "GET") => new Request(`http://localhost${path}`, { method });
const read = async (app: Kernel, path = "/", method = "GET") => {
  const response = await app.fetch(request(path, method));
  return { status: response.status, text: await response.text(), headers: response.headers };
};

describe.each(["trie", "regexp"] as const)("experimental immutable kernel: %s", (router) => {
  const create = () => new Kernel({ router });
  it("calls every text handler, rather than replacing constant-looking handlers", async () => {
    let count = 0;
    const app = create().text("GET", "/", () => String(++count));
    expect((await read(app)).text).toBe("1");
    expect((await read(app)).text).toBe("2");
    expect(() => app.text("GET", "/new", () => "late")).toThrow();
    expect(app.build()).toBe(app.build());
  });

  it("handles all benchmark route shapes with independent parameter expectations", async () => {
    const app = create()
      .text("GET", "/", () => "Hello World")
      .text("GET", "/user", () => "user")
      .text("GET", "/user/comments", () => "comments")
      .text("GET", "/user/avatar", () => "avatar")
      .text("GET", "/user/lookup/username/:username", (p) => `username:${p.username}`)
      .text("GET", "/user/lookup/email/:address", (p) => `email:${p.address}`)
      .text("GET", "/event/:id", (p) => `event:${p.id}`)
      .text("GET", "/event/:id/comments", (p) => `comments:${p.id}`)
      .text("POST", "/event/:id/comment", (p) => `comment:${p.id}`)
      .text("GET", "/map/:location/events", (p) => `map:${p.location}`)
      .text("GET", "/status", () => "status")
      .text("GET", "/very/deeply/nested/route/hello/there", () => "deep")
      .text("GET", "/static/*", (p) => `static:${p.wildcard}`);
    for (const [path, method, expected] of [
      ["/", "GET", "Hello World"],
      ["/user", "GET", "user"],
      ["/user/comments", "GET", "comments"],
      ["/user/avatar", "GET", "avatar"],
      ["/user/lookup/username/alice", "GET", "username:alice"],
      ["/user/lookup/email/a%40b.test", "GET", "email:a@b.test"],
      ["/event/42", "GET", "event:42"],
      ["/event/42/comments", "GET", "comments:42"],
      ["/event/42/comment", "POST", "comment:42"],
      ["/map/HK/events", "GET", "map:HK"],
      ["/status", "GET", "status"],
      ["/very/deeply/nested/route/hello/there", "GET", "deep"],
      ["/static/a/b.js", "GET", "static:a/b.js"],
    ]) {
      const result = await read(app, path, method);
      expect([result.status, result.text]).toEqual([200, expected]);
    }
  });

  it("uses method-first matching, static precedence and parameter backtracking", async () => {
    const app = create()
      .text("POST", "/users/new", () => "create")
      .text("GET", "/users/:id", (p) => p.id!)
      .text("GET", "/:id/end", (p) => p.id!)
      .text("GET", "/fixed/other", () => "static")
      .text("GET", "/users/fixed", () => "fixed");
    expect((await read(app, "/users/new")).text).toBe("new");
    expect((await read(app, "/users/new", "POST")).text).toBe("create");
    expect((await read(app, "/users/fixed")).text).toBe("fixed");
    expect((await read(app, "/fixed/end")).text).toBe("fixed");
  });

  it("decodes once per segment, rejects malformed escapes and retains owned params", async () => {
    const retained: Params[] = [];
    const app = create()
      .text("GET", "/x/:__proto__", async (p) => {
        retained.push(p);
        await Promise.resolve();
        return p.__proto__!;
      })
      .text("GET", "/static/*", (p) => p.wildcard!);
    expect((await read(app, "/x/a%2Fb")).text).toBe("a/b");
    expect((await read(app, "/x/a%252Fb")).text).toBe("a%2Fb");
    expect(retained[0]!.__proto__).toBe("a/b");
    expect(Object.getPrototypeOf(retained[0])).toBe(null);
    expect(retained[0]).not.toBe(retained[1]);
    expect((await read(app, "/x/%ZZ")).status).toBe(400);
    expect((await read(app, "/static")).text).toBe("");
    expect((await read(app, "/static/")).text).toBe("");
    expect((await read(app, "/static/a%2Fb/c")).text).toBe("a/b/c");
  });

  it("provides HEAD, OPTIONS, 405 and ALL, with UTF-8 byte lengths", async () => {
    const app = create()
      .text("GET", "/x", () => "你好")
      .route("GET", "/json", () => json({ a: 1 }))
      .text("ALL", "/any", () => "all");
    const head = await read(app, "/x", "HEAD");
    expect([head.status, head.text, head.headers.get("content-length")]).toEqual([200, "", "6"]);
    expect((await read(app, "/json", "HEAD")).headers.get("content-length")).toBe("7");
    const options = await read(app, "/x", "OPTIONS");
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect((await read(app, "/x", "POST")).status).toBe(405);
    expect((await read(app, "/missing")).status).toBe(404);
    expect((await read(app, "/any", "PATCH")).text).toBe("all");
  });

  it("seals registrations and rejects ambiguous or unsupported patterns", () => {
    for (const pattern of ["/x/:a/:a", "/x/:a?", "/x/*/rest", "/x/:a(.*)", "x"]) {
      expect(() =>
        create()
          .text("GET", pattern, () => "")
          .build(),
      ).toThrow();
    }
    expect(() =>
      create()
        .text("GET", "/x/:a", () => "")
        .text("GET", "/x/:b", () => "")
        .build(),
    ).toThrow();
    expect(() => create().use("/private/*", () => "")).toThrow();
  });

  it("creates Fetch capabilities only for matching routes/middleware and covers misses", async () => {
    const order: string[] = [];
    const app = create()
      .text("GET", "/public", () => "public")
      .text("GET", "/secure/value", () => "secret")
      .use("/secure", async (req, next) => {
        order.push("before");
        if (!req.headers.has("authorization")) return new Reply("denied", 403);
        const response = await next();
        order.push("after");
        response.headers.set("x-auth", "yes");
        return response;
      });
    const executable = app.build();
    expect(executable.needsRequest(executable.select("GET", "/public"))).toBe(false);
    expect(executable.needsRequest(executable.select("GET", "/secure/absent"))).toBe(true);
    for (const path of ["/secure/value", "/secure/missing", "/%73ecure/value"]) {
      expect((await read(app, path)).status).toBe(403);
    }
    expect((await read(app, "/secure/value", "POST")).status).toBe(403);
    const result = await app.fetch(
      new Request("http://localhost/secure/value", { headers: { authorization: "test" } }),
    );
    expect([await result.text(), result.headers.get("x-auth")]).toEqual(["secret", "yes"]);
    expect(order.slice(-2)).toEqual(["before", "after"]);
  });

  it("rejects double or floated next and joins downstream lifetime", async () => {
    const doubled = create()
      .text("GET", "/", () => "ok")
      .use("/", async (_req, next) => {
        await next();
        return await next();
      });
    expect((await read(doubled)).status).toBe(500);
    let settled = false;
    const floated = create()
      .text("GET", "/", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        settled = true;
        return "late";
      })
      .use("/", (_req, next) => {
        next();
        return "early";
      });
    expect((await read(floated)).status).toBe(500);
    expect(settled).toBe(true);
  });

  it("normalizes selection and middleware scope to the standard Request pathname", async () => {
    const app = create()
      .use("/secure", () => new Reply("denied", 403))
      .route("GET", "/*", (req) => new Response(new URL(req.url).pathname));
    for (const target of [
      "/secure/secret",
      "/public/../secure/secret",
      "/public/%2e%2e/secure/secret",
      "/public\\..\\secure/secret",
    ]) {
      const executable = app.build(),
        selected = executable.select("GET", target);
      expect(selected.path).toBe("/secure/secret");
      const result = await executable.invoke(selected, request(target));
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(403);
    }
  });

  it("cancels abandoned downstream bodies without cancelling transfers or deadlocking clones", async () => {
    for (const mode of ["replace", "throw", "partial-replace", "partial-throw"]) {
      let cancelled = false;
      const app = create()
        .route(
          "GET",
          "/",
          () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array([1]));
                },
                cancel() {
                  cancelled = true;
                },
              }),
            ),
        )
        .use("/", async (_req, next) => {
          const downstream = await next();
          if (mode.startsWith("partial")) {
            const reader = downstream.body!.getReader();
            await reader.read();
            reader.releaseLock();
          }
          if (mode.endsWith("throw")) throw new Error("middleware");
          return "replacement";
        });
      expect((await read(app)).text).toBe(
        mode.endsWith("throw") ? "Internal Server Error" : "replacement",
      );
      expect(cancelled).toBe(true);
    }
    const transferred = create()
      .route("GET", "/", () => new Response("transfer"))
      .use("/", async (_req, next) => new Response((await next()).body));
    expect((await read(transferred)).text).toBe("transfer");
    const cloned = create()
      .route("GET", "/", () => new Response("clone"))
      .use("/", async (_req, next) => (await next()).clone());
    expect((await read(cloned)).text).toBe("clone");
  });

  it("handles foreign thenables, handler errors and failed error hooks", async () => {
    const foreign = runInNewContext('Promise.resolve("foreign")') as PromiseLike<string>;
    expect((await read(create().text("GET", "/", () => foreign))).text).toBe("foreign");
    for (const handler of [
      () => {
        throw new URIError("handler fault");
      },
      () => Promise.reject(new Error("async fault")),
      () =>
        ({
          // eslint-disable-next-line unicorn/no-thenable -- foreign thenables are the contract under test
          then: () => {
            throw new Error("then fault");
          },
        }) as PromiseLike<string>,
      () => 42 as unknown as TextResult,
    ]) {
      expect((await read(create().text("GET", "/", handler))).status).toBe(500);
    }
    expect(
      (
        await read(
          create()
            .text("GET", "/", () => {
              throw new Error();
            })
            .onError(() => new Reply("mapped", 422)),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await read(
          create()
            .text("GET", "/", () => {
              throw new Error();
            })
            .onError(() => Promise.reject(new Error("failed hook"))),
        )
      ).status,
    ).toBe(500);
  });

  it("supports standard request bodies and snapshots response headers", async () => {
    const headers = new Headers({ "x-test": "original" });
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    const reply = new Reply("snapshot", 201, headers);
    headers.set("x-test", "changed");
    const app = create()
      .route("POST", "/echo/:id", async (req, p) => {
        expect("runtime" in req || "waitUntil" in req || "ip" in req).toBe(false);
        return json({ id: p.id, body: await req.text() });
      })
      .route("GET", "/reply", () => reply);
    const echo = await app.fetch(
      new Request("http://localhost/echo/3", { method: "POST", body: "hello" }),
    );
    expect(await echo.json()).toEqual({ id: "3", body: "hello" });
    const result = await app.fetch(request("/reply"));
    expect([result.status, result.headers.get("x-test"), result.headers.getSetCookie()]).toEqual([
      201,
      "original",
      ["a=1", "b=2"],
    ]);
    expect(() => json(undefined)).toThrow();
    expect(() => new Reply("body", 204)).toThrow();
  });

  it("rejects already consumed and locked response bodies", async () => {
    const consumed = new Response("used");
    await consumed.text();
    expect((await read(create().route("GET", "/", () => consumed))).status).toBe(500);
    const locked = new Response("locked"),
      reader = locked.body!.getReader();
    expect((await read(create().route("GET", "/", () => locked))).status).toBe(500);
    reader.releaseLock();
  });
});
