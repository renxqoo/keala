/**
 * Context recycling semantics .
 *
 * The core removed the `pooling: true` app option — pooling is now opt-in BY THE
 * HOST via the exported `resetContext` (recycle a context object in place for
 * the next request). These tests lock the recycling contract directly:
 * a recycled context must be indistinguishable from a freshly created one
 * (design contract #6: every field reset, `routerAllowed` cleared — the
 * field-conservation lock). The app-level cases re-check the user-visible
 * guarantees the old pooling suite covered (isolation across serial,
 * concurrent, error and cookie/header traffic) which the core provides by
 * construction (fresh context per request).
 *
 * The old "pooling stays correct with currentContext enabled" case is gone:
 * `currentContext` was removed from the core along with the pool.
 */

import { describe, expect, it } from "vitest";

import { Honu } from "../src/index.ts";
import {
  baseContextProto,
  createContext,
  resetContext,
  type Context,
} from "../src/core/context/context.ts";

const quiet = { env: "test" } as const;

/** A context that lived through a full, messy request lifecycle. */
const usedContext = (app = new Honu({ keys: ["k"] })): Context => {
  const c = createContext(app, baseContextProto, new Request("http://localhost:3000/a?x=1"), {
    remote: "1.1.1.1",
  });
  c.params = { id: "7" };
  c.routerAllowed.add("GET");
  c.state["step"] = 1;
  c.set("X-Used", "yes");
  c.append("Set-Cookie", "old=1; Path=/");
  c.status = 201;
  c.message = "created";
  c.body = "payload";
  c.cookies.set("sid", "one", { signed: true });
  // Materialize every lazy cache, then rewrite the url (drops them).
  void c.ip;
  void c.query;
  void c.originalUrl;
  c.url = "/rewritten?z=9";
  return c;
};

describe("resetContext recycling semantics", () => {
  it("field conservation: a recycled context carries exactly the fresh context's state fields", () => {
    const app = new Honu({ keys: ["k"] });
    const raw = new Request("http://localhost:3000/b?y=2");
    const runtime = { remote: "2.2.2.2" };
    const fresh = createContext(app, baseContextProto, raw, runtime);
    const recycled = resetContext(usedContext(app), raw, runtime);

    const freshKeys = Object.keys(fresh).toSorted();
    expect(Object.keys(recycled).toSorted()).toEqual(freshKeys);
    const freshState = fresh as unknown as Record<string, unknown>;
    const recycledState = recycled as unknown as Record<string, unknown>;
    for (const key of freshKeys) {
      expect(recycledState[key]).toEqual(freshState[key]);
    }
  });

  it("a recycled context reflects the new request only (no stale state)", () => {
    const recycled = resetContext(
      usedContext(),
      new Request("http://localhost:3000/b?y=2", { headers: { Cookie: "other=2" } }),
      { remote: "2.2.2.2" },
    );
    expect(recycled.url).toBe("/b?y=2");
    expect(recycled.path).toBe("/b");
    expect(recycled.query).toEqual({ y: "2" });
    expect(recycled.status).toBe(404);
    expect(recycled.body).toBe(null);
    expect(recycled.message).toBe("Not Found");
    expect(recycled.has("X-Used")).toBe(false);
    expect(recycled.resHeader("set-cookie")).toBe("");
    expect(Object.keys(recycled.state)).toEqual([]);
    expect(recycled.params).toBe(null);
    expect(recycled.ip).toBe("2.2.2.2");
    // Unsigned read: the app carries signing keys, and a signed read of an
    // unsigned value fails closed (by design) — the point here is that the
    // fresh facade parses the NEW request's Cookie header.
    expect(recycled.cookies.get("other", { signed: false })).toBe("2");
  });

  it("clears the 405 allowed-methods bookkeeping (contract #6: no foreign-405 leaks)", () => {
    const recycled = resetContext(
      usedContext(),
      new Request("http://localhost:3000/fresh"),
      undefined,
    );
    expect(recycled.routerAllowed.size).toBe(0);
    recycled.routerAllowed.add("POST");
    expect(recycled.routerAllowed.has("GET")).toBe(false);
  });

  it("re-resolves the remote address from the new runtime", () => {
    const c = usedContext();
    expect(c.ip).toBe("1.1.1.1");
    const recycled = resetContext(c, new Request("http://localhost:3000/next"), {
      remote: () => "3.3.3.3",
    });
    expect(recycled.ip).toBe("3.3.3.3");
  });
});

describe("request isolation (fresh context per request)", () => {
  it("serial requests never observe stale state", async () => {
    const app = new Honu(quiet);
    app.get("/a/:id", (c) => {
      c.state["id"] = c.params?.["id"];
      c.set("X-Run", String(c.state["id"]));
      c.body = JSON.stringify({ id: c.state["id"], q: c.query["v"] ?? null });
    });
    app.get("/b", (c) => {
      // No writes: every field must reflect THIS request, not the previous one.
      c.body = JSON.stringify({
        state: Object.keys(c.state).length,
        url: c.url,
        path: c.path,
        type: c.type,
      });
    });

    await app.handle(new Request("http://localhost:3000/a/1?v=first"));
    const second = await app.handle(new Request("http://localhost:3000/b"));
    const body = (await second.json()) as {
      state: number;
      url: string;
      path: string;
      type: string;
    };
    expect(body.state).toBe(0); // state was reset
    expect(body.url).toBe("/b");
    expect(body.path).toBe("/b");

    const third = await app.handle(new Request("http://localhost:3000/a/2?v=x"));
    const parsed = (await third.json()) as { id: string; q: string };
    expect(parsed).toEqual({ id: "2", q: "x" });
    expect(third.headers.get("x-run")).toBe("2");
  });

  it("concurrent interleaved requests keep isolated contexts", async () => {
    const app = new Honu(quiet);
    app.get("/slow/:tag", async (c) => {
      const mine = c.params?.["tag"] as string;
      await new Promise((resolve) => setTimeout(resolve, mine === "a" ? 15 : 2));
      c.body = `${mine}:${c.params?.["tag"]}`;
    });
    const results = await Promise.all([
      app.handle(new Request("http://localhost:3000/slow/a")),
      app.handle(new Request("http://localhost:3000/slow/b")),
      app.handle(new Request("http://localhost:3000/slow/a")),
    ]);
    const bodies = await Promise.all(results.map((r) => r.text()));
    expect(bodies).toEqual(["a:a", "b:b", "a:a"]);
  });

  it("error responses recycle cleanly", async () => {
    const app = new Honu({ ...quiet });
    app.onError(() => {});
    app.get("/ok", (c) => {
      c.body = `fresh:${c.state["step"] ?? "0"}`;
    });
    app.get("/boom", async () => {
      throw new Error("planned");
    });
    await app.handle(new Request("http://localhost:3000/boom"));
    const res = await app.handle(new Request("http://localhost:3000/ok"));
    expect(await res.text()).toBe("fresh:0");
  });

  it("cookies and headers do not leak between requests", async () => {
    const app = new Honu({ ...quiet, keys: ["k"] });
    app.use(async (c) => {
      if (c.path === "/set") {
        c.cookies.set("sid", "one", { signed: true });
        c.set("X-Custom", "first");
        return;
      }
      c.body = [
        c.cookies.get("sid") ?? "none",
        c.resHeader("X-Custom") || "none",
        c.headers.get("x-incoming") ?? "none",
      ].join("|");
    });
    await app.handle(new Request("http://localhost:3000/set"));
    const res = await app.handle(
      new Request("http://localhost:3000/get", { headers: { "X-Incoming": "yes" } }),
    );
    expect(await res.text()).toBe("none|none|yes");
  });

  it("stream bodies still deliver across requests", async () => {
    const app = new Honu(quiet);
    app.use(async (c) => {
      c.body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed"));
          controller.close();
        },
      });
    });
    const first = await app.handle(new Request("http://localhost:3000/"));
    expect(await first.text()).toBe("streamed");
    const second = await app.handle(new Request("http://localhost:3000/"));
    expect(await second.text()).toBe("streamed");
  });
});
