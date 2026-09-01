import { describe, expect, it } from "vitest";
import { Keala } from "../src/core/app.ts";
import {
  COMMITTED_HEADERS_IMMUTABLE,
  COMMITTED_HEADERS_UNKNOWN,
  trySetCommittedHeader,
} from "../src/core/committed-headers.ts";
import { createContext, resetContext } from "../src/core/context/context.ts";
import { FLAG_COMMITTED_HEADERS_APPLIED } from "../src/core/context/state.ts";
import type { Context } from "../src/core/context/context.ts";

const request = (path = "/"): Request => new Request(`http://localhost${path}`);

type LateOperation = (c: Context) => void;

const responseSnapshot = async (
  forceFallback: boolean,
  operations: readonly LateOperation[],
): Promise<unknown> => {
  const app = new Keala({ env: "production" });
  app.use(async (c, next) => {
    await next();
    if (forceFallback) c.committedHeadersState = COMMITTED_HEADERS_IMMUTABLE;
    for (const operation of operations) operation(c);
  });
  app.get(
    "/",
    () =>
      new Response("original", {
        headers: {
          "content-type": "text/plain",
          "set-cookie": "early=1; Path=/",
          vary: "accept",
          "x-base": "one",
        },
      }),
  );
  const response = await app.handle(request());
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()]
      .filter(([name]) => name !== "set-cookie")
      .toSorted(([a], [b]) => a.localeCompare(b)),
    cookies: response.headers.getSetCookie(),
    body: [...new Uint8Array(await response.arrayBuffer())],
  };
};

describe("R4.1 committed header fast lane", () => {
  it("applies a late ordinary set to the committed Response without replacing it", async () => {
    const app = new Keala({ env: "production" });
    let committed: Response | undefined;
    let observed = false;

    app.use(async (c, next) => {
      await next();
      c.set("X-Late", "one");
      observed = c.has("x-late") && c.resHeader("X-Late") === "one";
    });
    app.get("/", (c) => (committed = c.text("hello")));

    const response = await app.handle(request());
    expect(response).toBe(committed);
    expect(observed).toBe(true);
    expect(response.headers.get("x-late")).toBe("one");
    expect(response.headers.get("content-type") ?? "").toMatch(
      /^text\/plain\s*;\s*charset=utf-8$/i,
    );
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

  it("keeps late append and vary observable while retaining Response identity", async () => {
    const app = new Keala({ env: "production" });
    let committed: Response | undefined;

    app.use(async (c, next) => {
      await next();
      c.append("X-List", "two");
      c.vary("accept-encoding");
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

  it("replays a fast set onto a newer Response returned by an outer middleware", async () => {
    const app = new Keala({ env: "production" });

    app.use(async (c, next) => {
      await next();
      c.set("X-Carry", "yes");
      return new Response("outer", { headers: { "x-outer": "yes" } });
    });
    app.get("/", (c) => c.text("inner"));

    const response = await app.handle(request());
    expect(response.headers.get("x-carry")).toBe("yes");
    expect(response.headers.get("x-outer")).toBe("yes");
    expect(await response.text()).toBe("outer");
  });

  it("replays a fast removal onto a newer Response returned by an outer middleware", async () => {
    const app = new Keala({ env: "production" });

    app.use(async (c, next) => {
      await next();
      c.remove("X-Remove");
      return new Response("outer", { headers: { "x-remove": "outer", "x-keep": "yes" } });
    });
    app.get("/", () => new Response("inner", { headers: { "x-remove": "inner" } }));

    const response = await app.handle(request());
    expect(response.headers.get("x-remove")).toBeNull();
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

  it("probes an immutable Headers guard once, then stays on fallback", () => {
    let attempts = 0;
    const context = {
      _res: {
        headers: {
          set: () => {
            attempts++;
            throw new TypeError("immutable");
          },
        },
      },
      flags: 0,
      headersRecord: null,
      committedHeadersState: COMMITTED_HEADERS_UNKNOWN,
    } as unknown as Parameters<typeof trySetCommittedHeader>[0];

    expect(trySetCommittedHeader(context, "x-one", "1")).toBe(false);
    expect(trySetCommittedHeader(context, "x-two", "2")).toBe(false);
    expect(attempts).toBe(1);
    expect(context.committedHeadersState).toBe(COMMITTED_HEADERS_IMMUTABLE);
    expect(context.flags & FLAG_COMMITTED_HEADERS_APPLIED).toBe(0);
  });

  it("falls back for an actually guarded Response and still preserves its headers", async () => {
    const app = new Keala({ env: "production" });
    const fetched = await fetch("data:text/plain,hello");
    const originalContentType = fetched.headers.get("content-type");

    app.use(async (c, next) => {
      await next();
      c.set("X-Late", "yes");
    });
    app.get("/", () => fetched);

    const response = await app.handle(request());
    expect(response.headers.get("x-late")).toBe("yes");
    expect(response.headers.get("content-type")).toBe(originalContentType);
    expect(await response.text()).toBe("hello");
  });

  it("keeps Set-Cookie, singleton headers and multi-append on semantic fallback", async () => {
    const app = new Keala({ env: "production" });
    let committed: Response | undefined;

    app.use(async (c, next) => {
      await next();
      c.set("Set-Cookie", "late=1; Path=/");
      c.set("Content-Type", "application/custom");
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
    expect(response).not.toBe(committed);
    expect(response.headers.getSetCookie()).toEqual(["early=1; Path=/", "late=1; Path=/"]);
    expect(response.headers.get("content-type")).toBe("application/custom");
    expect(response.headers.get("x-many")).toBe("one, two, three");
  });

  it("rebuilds after a fast set when a later body rewrite requires semantic mode", async () => {
    const app = new Keala({ env: "production" });
    let committed: Response | undefined;

    app.use(async (c, next) => {
      await next();
      c.set("X-Fast", "yes");
      c.body = "replacement";
    });
    app.get(
      "/",
      () =>
        (committed = new Response("original", {
          headers: { "content-length": "8", "x-original": "yes" },
        })),
    );

    const response = await app.handle(request());
    expect(response).not.toBe(committed);
    expect(response.headers.get("x-fast")).toBe("yes");
    expect(response.headers.get("x-original")).toBe("yes");
    expect(response.headers.get("content-length")).not.toBe("8");
    expect(await response.text()).toBe("replacement");
  });

  it("does not skip a cookie written through a facade created before commit", async () => {
    const app = new Keala({ env: "production" });

    app.use(async (c, next) => {
      const cookies = c.cookies;
      await next();
      c.set("X-Fast", "yes");
      cookies.set("session", "late", { secure: false });
    });
    app.get("/", (c) => c.text("hello"));

    const response = await app.handle(request());
    expect(response.headers.get("x-fast")).toBe("yes");
    expect(response.headers.getSetCookie()).toEqual([expect.stringContaining("session=late")]);
  });

  it("resets committed-header capability when a context is recycled", () => {
    const app = new Keala({ env: "production" });
    const first = createContext(app, {}, request("/first"), undefined);
    first.committedHeadersState = COMMITTED_HEADERS_IMMUTABLE;
    first.flags |= FLAG_COMMITTED_HEADERS_APPLIED;

    resetContext(first, request("/second"), undefined);
    expect(first.committedHeadersState).toBe(COMMITTED_HEADERS_UNKNOWN);
    expect(first.flags & FLAG_COMMITTED_HEADERS_APPLIED).toBe(0);
  });

  it.each([
    ["set last-write-wins", [(c: Context) => c.set("X-Base", "two")]],
    ["remove", [(c: Context) => c.remove("X-Base")]],
    [
      "remove then set",
      [(c: Context) => c.remove("X-Base"), (c: Context) => c.set("X-Base", "three")],
    ],
    ["set then remove", [(c: Context) => c.set("X-New", "two"), (c: Context) => c.remove("X-New")]],
    ["append", [(c: Context) => c.append("X-Base", "two")]],
    [
      "vary dedupe and append",
      [(c: Context) => c.vary("accept"), (c: Context) => c.vary("origin")],
    ],
    [
      "direct then singleton fallback",
      [
        (c: Context) => c.set("X-New", "two"),
        (c: Context) => c.set("Content-Type", "application/custom"),
      ],
    ],
    [
      "direct then cookie fallback",
      [
        (c: Context) => c.set("X-New", "two"),
        (c: Context) => c.cookies.set("late", "1", { secure: false }),
      ],
    ],
    [
      "direct then body rewrite",
      [(c: Context) => c.set("X-New", "two"), (c: Context) => (c.body = "replacement")],
    ],
    [
      "direct then empty status",
      [(c: Context) => c.set("X-New", "two"), (c: Context) => (c.status = 204)],
    ],
  ] satisfies [string, LateOperation[]][])(
    "matches forced semantic fallback for %s",
    async (_name, operations) => {
      expect(await responseSnapshot(false, operations)).toEqual(
        await responseSnapshot(true, operations),
      );
    },
  );
});
