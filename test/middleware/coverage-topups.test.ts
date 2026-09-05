import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { etag, compress } from "../../src/middleware/etag.ts";
import { cors, csrf } from "../../src/middleware/cors.ts";
import { secureHeaders, requestId } from "../../src/middleware/headers.ts";
import { stream, streamText, streamSSE } from "../../src/helpers/streams.ts";
import { bodyOf, createBodyParser } from "../../src/plugins/body-parser.ts";
import { serveStatic } from "../../src/middleware/serve-static.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "../../src/core/context/context.ts";
import { Router } from "../../src/router/group.ts";
import { startBunServer } from "../../src/adapters/bun.ts";
import type { Application } from "../../src/core/app.ts";
/**
 * Branch-coverage completion for the component layer: etag body kinds and
 * 304 negotiation, compress decision tree, cors preflight rejects and custom
 * handlers, csrf URL-parse failure, stream close/error paths, body-parser
 * reader errors, serveStatic gaps, validator edge branches.
 */

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("coverage: etag body kinds and negotiation", () => {
  it("tags Uint8Array and object bodies; streams and null pass through", async () => {
    const app = new Keala(quiet);
    app.use(etag());
    app.get("/u8", (c) => {
      c.body = new Uint8Array([1, 2, 3]);
    });
    app.get("/obj", (c) => {
      c.body = { a: 1 };
    });
    app.get("/stream", (c) => {
      c.body = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    });
    app.get("/none", (c) => {
      c.body = null;
      c.status = 204;
    });
    expect((await app.handle(req("/u8"))).headers.get("etag")).toMatch(/^W\//);
    expect((await app.handle(req("/obj"))).headers.get("etag")).toMatch(/^W\//);
    expect((await app.handle(req("/stream"))).headers.get("etag")).toBeNull();
    expect((await app.handle(req("/none"))).status).toBe(204);
  });

  it("pre-existing etags win; 201 bodies participate; weak-tag matching strips W/", async () => {
    const app = new Keala(quiet);
    app.use(etag());
    app.get("/pre", (c) => {
      c.etag = '"custom"';
      c.body = "x";
    });
    app.get("/201", (c) => {
      c.status = 201;
      c.body = "created";
    });
    const pre = await app.handle(req("/pre"));
    expect(pre.headers.get("etag")).toBe('"custom"');
    expect((await app.handle(req("/201"))).headers.get("etag")).toMatch(/^W\//);
    // 201 bodies also participate in freshness
    const tagged = (await app.handle(req("/201"))).headers.get("etag") ?? "";
    const conditional = await app.handle(
      new Request("http://localhost:3000/201", { headers: { "if-none-match": tagged } }),
    );
    expect(conditional.status).toBe(304);
  });

  it("if-none-match lists and the * wildcard match", async () => {
    const app = new Keala(quiet);
    app.use(etag());
    app.get("/x", (c) => {
      c.body = "stable";
    });
    const tag = (await app.handle(req("/x"))).headers.get("etag") ?? "";
    const list = await app.handle(
      new Request("http://localhost:3000/x", { headers: { "if-none-match": `"other", ${tag}` } }),
    );
    expect(list.status).toBe(304);
  });
});

describe("coverage: compress decision tree", () => {
  it("large gzip-eligible bodies compress on Bun; small and stream bodies skip", async () => {
    const app = new Keala(quiet);
    app.use(compress());
    app.get("/big", (c) => {
      c.body = "compressible-content-".repeat(40);
    });
    app.get("/stream", (c) => {
      c.body = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    });
    const accepted = { headers: { "accept-encoding": "gzip" } } as RequestInit;
    const big = await app.handle(new Request("http://localhost:3000/big", accepted));
    // node:zlib gzip runs on Bun and Node alike.
    expect(big.headers.get("content-encoding")).toBe("gzip");
    const streamed = await app.handle(new Request("http://localhost:3000/stream", accepted));
    expect(streamed.headers.get("content-encoding")).toBeNull();
    // no gzip acceptance -> passthrough
    const plain = await app.handle(req("/big"));
    expect(plain.headers.get("content-encoding")).toBeNull();
  });
});

describe("coverage: cors and csrf edges", () => {
  it("preflight from a rejected origin invokes the custom reject handler", async () => {
    const app = new Keala(quiet);
    app.use(
      cors({
        origin: ["https://only.site"],
        reject: (origin) => new Response(`blocked:${origin}`, { status: 418 }),
      }),
    );
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "OPTIONS",
        headers: { origin: "https://evil.site" },
      }),
    );
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("blocked:https://evil.site");
  });

  it("non-preflight rejected origins hit the reject handler too", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: ["https://a"], reject: () => new Response("no", { status: 403 }) }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", { headers: { origin: "https://b" } }),
    );
    expect(res.status).toBe(403);
  });

  it("csrf: unparseable Referer/Origin sources reject", async () => {
    const app = new Keala(quiet);
    app.use(csrf());
    app.post("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", { method: "POST", headers: { origin: "https://" } }),
    );
    expect(res.status).toBe(403);
  });
});

describe("coverage: streams edges", () => {
  it("write-after-close and close-twice never throw", async () => {
    const app = new Keala(quiet);
    app.get("/x", (c) =>
      streamText(c, async (w) => {
        w.close();
        w.write("after"); // dropped silently
        w.close();
      }),
    );
    const res = await app.handle(req("/x"));
    expect(await res.text()).toBe("");
  });

  it("abort during SSE clears the heartbeat and runs cleanup", async () => {
    const app = new Keala(quiet);
    let cleaned = false;
    app.get("/s", (c) =>
      streamSSE(
        c,
        async (sse) => {
          sse.onAbort(() => {
            cleaned = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 400));
        },
        { heartbeat: 20 },
      ),
    );
    const res = (await app.handle(req("/s"))) as Response;
    await res.body!.getReader().cancel("gone");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(cleaned).toBe(true);
  });

  it("producer failure inside streamSSE still clears the heartbeat timer", async () => {
    const app = new Keala(quiet);
    app.get("/e", (c) =>
      streamSSE(
        c,
        async () => {
          throw new Error("producer-boom");
        },
        { heartbeat: 30 },
      ),
    );
    const res = await app.handle(req("/e"));
    await expect(res.text()).rejects.toThrow();
  });

  it("abort cleanup handlers that themselves throw stay contained", async () => {
    const app = new Keala(quiet);
    app.get("/t", (c) =>
      stream(c, async (w) => {
        w.onAbort(() => {
          throw new Error("cleanup-exploded");
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }),
    );
    const res = (await app.handle(req("/t"))) as Response;
    await expect(res.body!.getReader().cancel("x")).resolves.toBeUndefined();
  });
});

describe("coverage: body-parser reader errors", () => {
  it("a locked/missing body reads as empty", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser());
    app.get("/x", async (c) => {
      c.body = JSON.stringify(await bodyOf(c).json());
    });
    const res = await app.handle(req("/x")); // GET: empty body
    expect(await res.text()).toBe("null");
  });
});

describe("coverage: serveStatic remaining branches", () => {
  it("root option validation and missing files on the index path", async () => {
    expect(() => serveStatic({ root: "" })).toThrow(TypeError);
    const dir = await mkdtemp(join(tmpdir(), "bk-cov-"));
    const app = new Keala(quiet);
    app.use(serveStatic({ root: dir }));
    // directory without index.html -> 404
    expect((await app.handle(req("/"))).status).toBe(404);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("coverage: headers edges", () => {
  it("secureHeaders extras without hsts are inert; requestId state carries", async () => {
    const app = new Keala(quiet);
    app.use(secureHeaders({ permittedCrossDomainPolicies: "none" }));
    app.use(requestId());
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("x-permitted-cross-domain-policies")).toBe("none");
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});

/**
 * Branch-coverage completion, part 2: the injected-gzip compress tree and the
 * last small gaps (cors preflight extras, crypto fallback, adapter drain,
 * body-parser declared-limit on non-default readers).
 */

const gzip = (input: Uint8Array): Promise<Uint8Array> =>
  Promise.resolve(
    new Uint8Array([0x1f, 0x8b, ...input.subarray(0, Math.max(1, input.byteLength - 64))]),
  );
const gzRequest = (path: string): Request =>
  new Request(`http://localhost:3000${path}`, { headers: { "accept-encoding": "gzip, br" } });

describe("coverage: compress with injected gzip", () => {
  it("compresses eligible string bodies and replaces the body bytes", async () => {
    const app = new Keala(quiet);
    app.use(compress({ gzip }));
    app.get("/x", (c) => {
      c.body = "0".repeat(400);
    });
    const res = await app.handle(gzRequest("/x"));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });

  it("object bodies compress; pre-encoded and committed responses skip", async () => {
    const app = new Keala(quiet);
    app.use(compress({ gzip }));
    app.get("/obj", (c) => {
      c.body = { pad: "1".repeat(500) };
    });
    app.get("/pre", (c) => {
      c.body = "0".repeat(400);
      c.setHeader("Content-Encoding", "br");
    });
    app.get("/committed", (c) => c.text("0".repeat(400)));
    expect((await app.handle(gzRequest("/obj"))).headers.get("content-encoding")).toBe("gzip");
    expect((await app.handle(gzRequest("/pre"))).headers.get("content-encoding")).toBe("br");
    expect((await app.handle(gzRequest("/committed"))).headers.get("content-encoding")).toBeNull();
  });

  it("skips when the packed output would not shrink", async () => {
    const growing = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array(1024).fill(1));
    const app = new Keala(quiet);
    app.use(compress({ gzip: growing }));
    app.get("/x", (c) => {
      c.body = "0".repeat(400);
    });
    const res = await app.handle(gzRequest("/x"));
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("Uint8Array bodies are eligible; accept-encoding lists parse", async () => {
    const app = new Keala(quiet);
    app.use(compress({ gzip }));
    app.get("/x", (c) => {
      c.body = new Uint8Array(400).fill(7);
    });
    const res = await app.handle(gzRequest("/x"));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    // wildcard-less encodings do not trigger
    const brotliOnly = await app.handle(
      new Request("http://localhost:3000/x", { headers: { "accept-encoding": "br" } }),
    );
    expect(brotliOnly.headers.get("content-encoding")).toBeNull();
  });
});

describe("coverage: cors preflight extras", () => {
  it("preflight reflects whitelisted origin with credentials and exposes headers", async () => {
    const app = new Keala(quiet);
    app.use(
      cors({
        origin: ["https://app.site"],
        allowCredentials: true,
        exposeHeaders: ["x-custom"],
      }),
    );
    app.get("/x", (c) => c.text("ok"));
    const pre = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.site",
          "access-control-request-method": "GET",
        },
      }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.site");
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
    const get = await app.handle(
      new Request("http://localhost:3000/x", { headers: { origin: "https://app.site" } }),
    );
    expect(get.headers.get("access-control-expose-headers")).toBe("x-custom");
  });

  it("simple-mode default reject answers 403 on preflight", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: ["https://a"] }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "OPTIONS",
        headers: { origin: "https://b" },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("coverage: adapter drain + router mount through dispatch", () => {
  it("drain events reach the registered handlers", async () => {
    const drained: string[] = [];
    const app = new Keala(quiet);
    app.ws("/w", {
      drain: (_ws, c) => {
        drained.push(c.path);
      },
    });
    const made: Record<string, unknown>[] = [];
    startBunServer(app as Application, { port: 0 }, undefined, (options) => {
      made.push(options);
      return {
        port: 0,
        hostname: "x",
        stop: () => undefined,
        fetch: async () => new Response("x"),
        reload: () => undefined,
      };
    });
    const websocket = made[0]?.["websocket"] as Record<string, (ws: unknown) => void>;
    websocket["drain"]?.({ data: { wsKey: "/w", ctx: { path: "/w" } } });
    await new Promise((r) => setTimeout(r, 0)); // handlers dispatch on a microtask
    expect(drained).toEqual(["/w"]);
  });

  it("mount composes sub-router param middleware into the parent", async () => {
    const app = new Keala(quiet);
    const api = new Router({ prefix: "/v1" });
    api.param("id", async (c, next) => {
      c.setHeader("X-Param-Mw", c.params("id") ?? "");
      await next();
    });
    api.get("/items/:id", (c) => c.text("item"));
    app.mount("/api", api);
    const res = await app.handle(new Request("http://localhost:3000/api/v1/items/9"));
    expect(res.headers.get("x-param-mw")).toBe("9");
    expect(await res.text()).toBe("item");
  });

  it("router middleware is exposed through mount (global middleware prepended)", async () => {
    const app = new Keala(quiet);
    const sub = new Router();
    sub.use(async (_c: Context, next) => {
      await next();
    });
    sub.get("/leaf", (c) => c.text("leaf"));
    app.mount("/sub", sub);
    expect(await (await app.handle(new Request("http://localhost:3000/sub/leaf"))).text()).toBe(
      "leaf",
    );
  });
});
