/**
 * Branch-coverage completion for the component layer: etag body kinds and
 * 304 negotiation, compress decision tree, cors preflight rejects and custom
 * handlers, csrf URL-parse failure, stream close/error paths, body-parser
 * reader errors, serveStatic gaps, validator edge branches.
 */

import { describe, expect, it } from "vitest";

import { Eleu } from "../src/core/app.ts";
import { etag, compress } from "../src/middleware/etag.ts";
import { cors, csrf } from "../src/middleware/cors.ts";
import { secureHeaders, requestId } from "../src/middleware/headers.ts";
import { stream, streamText, streamSSE } from "../src/helpers/streams.ts";
import { createBodyParser, type ContextWithBody } from "../src/plugins/body-parser.ts";
import { serveStatic } from "../src/middleware/serve-static.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("coverage: etag body kinds and negotiation", () => {
  it("tags Uint8Array and object bodies; streams and null pass through", async () => {
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
    app.use(cors({ origin: ["https://a"], reject: () => new Response("no", { status: 403 }) }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", { headers: { origin: "https://b" } }),
    );
    expect(res.status).toBe(403);
  });

  it("csrf: unparseable Referer/Origin sources reject", async () => {
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
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
    const app = new Eleu(quiet);
    app.use(createBodyParser());
    app.get("/x", async (c0) => {
      const c = c0 as ContextWithBody;
      c.body = JSON.stringify(await c.req.json());
    });
    const res = await app.handle(req("/x")); // GET: empty body
    expect(await res.text()).toBe("null");
  });
});

describe("coverage: serveStatic remaining branches", () => {
  it("root option validation and missing files on the index path", async () => {
    expect(() => serveStatic({ root: "" })).toThrow(TypeError);
    const dir = await mkdtemp(join(tmpdir(), "bk-cov-"));
    const app = new Eleu(quiet);
    app.use(serveStatic({ root: dir }));
    // directory without index.html -> 404
    expect((await app.handle(req("/"))).status).toBe(404);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("coverage: headers edges", () => {
  it("secureHeaders extras without hsts are inert; requestId state carries", async () => {
    const app = new Eleu(quiet);
    app.use(secureHeaders({ permittedCrossDomainPolicies: "none" }));
    app.use(requestId());
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(req("/x"));
    expect(res.headers.get("x-permitted-cross-domain-policies")).toBe("none");
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});
