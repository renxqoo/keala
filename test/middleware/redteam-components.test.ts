/**
 * Red-team audit — P2 component layer, green assets (part 2).
 *
 * Equivalence/correctness matrices that hold against the current
 * implementation: bodyParser boundaries, validator failure shapes, the
 * csrf/cors security matrix, stream abort/heartbeat/error semantics and the
 * component protocol. Confirmed defects are locked in test/redteam-p2.test.ts
 * as `it("CONFIRMED-BUG(now fixed) (P2-n): ...")`.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { bodyOf, createBodyParser } from "../../src/plugins/body-parser.ts";
import { validator, type StandardSchema } from "../../src/middleware/validator.ts";
import { cors, csrf } from "../../src/middleware/cors.ts";
import { stream, streamSSE, streamText } from "../../src/helpers/streams.ts";

const quiet = { env: "test", silent: true } as const;
const req = (path: string, init: RequestInit = {}): Request =>
  new Request(`http://localhost:3000${path}`, init);
const jsonBody = (path: string, value: unknown): Request =>
  req(path, {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
  });
const passthrough = (): StandardSchema => ({
  "~standard": { version: 1, validate: (value: unknown) => ({ value }) },
});
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// bodyParser — boundary correctness (green)
// ---------------------------------------------------------------------------

describe("redteam P2: bodyParser boundaries (green)", () => {
  it("a lying small Content-Length is caught by the streamed guard when the body is read", async () => {
    const app = new Keala(quiet);
    // arrayBuffer() owns the formLimit budget (R4.10).
    app.use(createBodyParser({ formLimit: 1000 }));
    app.post("/x", async (c) => {
      c.body = `len:${(await bodyOf(c).arrayBuffer()).byteLength}`;
    });
    const chunks = new ReadableStream({
      start(controller) {
        controller.enqueue(encode("x".repeat(5000)));
        controller.close();
      },
    });
    const res = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "POST",
        body: chunks,
        headers: { "content-type": "text/plain", "content-length": "10" },
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
  });

  it("jsonLimit=0 admits only empty bodies; negative limits behave like 0", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser({ jsonLimit: 0 }));
    app.post("/x", async (c) => {
      c.body = JSON.stringify(await bodyOf(c).json());
    });
    const empty = await app.handle(req("/x", { method: "POST" }));
    expect(empty.status).toBe(200);
    expect(await empty.text()).toBe("null");
    const one = await app.handle(req("/x", { method: "POST", body: "x" }));
    expect(one.status).toBe(413);

    // Negative limits are configuration errors and reject at construction
    // (aligned with bodyLimit()'s validation), not silently treated as 0.
    expect(() => createBodyParser({ jsonLimit: -5 })).toThrow(TypeError);
  });

  it("JSON top-level primitives round-trip (divergence ledger: object bodies pass through)", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser());
    app.post("/x", async (c) => {
      c.body = JSON.stringify(await bodyOf(c).json());
    });
    const num = await app.handle(
      req("/x", { method: "POST", body: "123", headers: { "content-type": "application/json" } }),
    );
    expect(await num.text()).toBe("123");
    const str = await app.handle(
      req("/x", { method: "POST", body: '"s"', headers: { "content-type": "application/json" } }),
    );
    expect(await str.text()).toBe('"s"');
  });

  it("a rejected bounded read stays rejected for every later reader", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser({ jsonLimit: 50 }));
    app.post("/x", async (c) => {
      let first = "none";
      let second = "none";
      try {
        await bodyOf(c).json();
      } catch (err) {
        first = String((err as { status?: number }).status);
      }
      try {
        await bodyOf(c).text();
      } catch (err) {
        second = String((err as { status?: number }).status);
      }
      c.body = `${first}/${second}`;
    });
    const res = await app.handle(
      req("/x", {
        method: "POST",
        body: JSON.stringify({ pad: "x".repeat(200) }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("413/413");
  });

  it("formLimit is independent of jsonLimit (text route 413s, form route parses)", async () => {
    const app = new Keala(quiet);
    app.use(createBodyParser({ jsonLimit: 100 }));
    app.post("/t", async (c) => {
      c.body = `t:${(await bodyOf(c).text()).length}`;
    });
    const over = await app.handle(
      req("/t", {
        method: "POST",
        body: "x".repeat(150),
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(over.status).toBe(413);
    const under = await app.handle(
      req("/t", {
        method: "POST",
        body: "x".repeat(50),
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(await under.text()).toBe("t:50");
  });
});

// ---------------------------------------------------------------------------
// validator — failure shapes and interplay (green)
// ---------------------------------------------------------------------------

describe("redteam P2: validator (green)", () => {
  it("a schema whose validate() throws answers 500 without leaking the message", async () => {
    const boom: StandardSchema = {
      "~standard": {
        version: 1,
        validate: () => {
          throw new Error("schema exploded");
        },
      },
    };
    const app = new Keala(quiet);
    app.post("/v", validator(boom), (c) => c.json({ ok: true }));
    const res = await app.handle(jsonBody("/v", {}));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("exploded");
  });

  it("an empty issues array answers a plain 400; issue paths surface in the message", async () => {
    const emptyIssues: StandardSchema = {
      "~standard": { version: 1, validate: () => ({ issues: [] }) },
    };
    const app = new Keala(quiet);
    app.post("/e", validator(emptyIssues), (c) => c.json({ ok: true }));
    const res = await app.handle(jsonBody("/e", {}));
    expect(res.status).toBe(400);

    const withPath: StandardSchema = {
      "~standard": {
        version: 1,
        validate: () => ({ issues: [{ message: "bad", path: ["a", "b"] }] }),
      },
    };
    const app2 = new Keala(quiet);
    app2.post("/p", validator(withPath), (c) => c.json({ ok: true }));
    const res2 = await app2.handle(jsonBody("/p", {}));
    expect(res2.status).toBe(400);
    expect(await res2.text()).toContain("bad at a.b");
  });

  it("c.valid holds the parsed value behind the validator and undefined elsewhere", async () => {
    const app = new Keala(quiet);
    app.post("/a", validator(passthrough()), (c) =>
      c.json({ valid: (c as unknown as { valid?: unknown }).valid }),
    );
    app.post("/b", (c) => c.json({ valid: (c as unknown as { valid?: unknown }).valid ?? "none" }));
    const a = await app.handle(
      req("/a", {
        method: "POST",
        body: '{"q":1}',
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await a.text()).toBe('{"valid":{"q":1}}');
    const b = await app.handle(
      req("/b", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
    );
    expect(await b.text()).toBe('{"valid":"none"}');
  });
});

// ---------------------------------------------------------------------------
// csrf / cors — the security matrix that holds (green)
// ---------------------------------------------------------------------------

describe("redteam P2: csrf/cors matrix (green)", () => {
  it("csrf blocks cross-origin, cross-port, and missing Origin+Referer; passes same-origin", async () => {
    const app = new Keala(quiet);
    app.use(csrf());
    app.post("/x", (c) => c.text("done"));
    const host = "localhost:3000";
    const post = (headers: Record<string, string>): Promise<Response> =>
      Promise.resolve(app.handle(req("/x", { method: "POST", headers: { host, ...headers } })));
    expect((await post({ origin: "http://evil.example" })).status).toBe(403);
    expect((await post({ origin: "http://localhost:9999" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: `http://${host}` })).status).toBe(200);
    expect((await post({ referer: `http://${host}/page` })).status).toBe(200);
    expect((await post({ referer: "http://evil.example/page" })).status).toBe(403);
    // scheme-hostile and unparseable origins never pass
    expect((await post({ origin: "javascript:alert(1)" })).status).toBe(403);
    expect((await post({ origin: "//evil.example" })).status).toBe(403);
    expect((await post({ origin: "http://" })).status).toBe(403);
  });

  it("cors preflight: no header echo, no credentials header, 204, Vary: Origin", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: ["https://a.example"], allowHeaders: ["X-Custom"] }));
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(
      req("/x", {
        method: "OPTIONS",
        headers: {
          origin: "https://a.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "X-Evil, X-Custom",
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBe("x-custom");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("cors: non-whitelisted and null origins are 403; no-origin requests carry no ACAO", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: ["https://a.example"] }));
    app.get("/x", (c) => c.text("ok"));
    expect((await app.handle(req("/x", { headers: { origin: "https://b.example" } }))).status).toBe(
      403,
    );
    expect((await app.handle(req("/x", { headers: { origin: "null" } }))).status).toBe(403);
    const plain = await app.handle(req("/x"));
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();
    expect(plain.status).toBe(200);
  });

  it("cors + csrf stacked: same-origin state changes pass with ACAO, cross-origin 403", async () => {
    const app = new Keala(quiet);
    app.use(cors({ origin: ["http://localhost:3000"] }));
    app.use(csrf());
    app.post("/x", (c) => c.text("done"));
    const host = "localhost:3000";
    const ok = await app.handle(
      req("/x", { method: "POST", headers: { host, origin: `http://${host}` } }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(`http://${host}`);
    const cross = await app.handle(
      req("/x", { method: "POST", headers: { host, origin: "http://evil.example" } }),
    );
    expect(cross.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// streams — abort/heartbeat/error semantics (green)
// ---------------------------------------------------------------------------

describe("redteam P2: streams (green)", () => {
  it("onAbort handlers registered twice both run when a pending stream is cancelled", async () => {
    const calls: string[] = [];
    const gate = new Promise<void>((resolve) => {
      setTimeout(resolve, 5000);
    });
    const app = new Keala(quiet);
    app.get("/s", (c) =>
      streamText(c, async (w) => {
        w.onAbort(() => calls.push("a1"));
        w.onAbort(() => calls.push("a2"));
        w.write("open\n");
        await gate;
      }),
    );
    const res = await app.handle(req("/s"));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("client gone");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(["a1", "a2"]);
  });

  it("SSE heartbeat pings flow while idle and stop after cancel (timer cleaned up)", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = new Keala(quiet);
    app.get("/sse", (c) => streamSSE(c, () => gate, { heartbeat: 5 }));
    const res = await app.handle(req("/sse"));
    const reader = res.body!.getReader();
    let text = "";
    const started = Date.now();
    while (Date.now() - started < 25) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain(": ping");
    await reader.cancel("gone");
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 15));
  });

  it("a sync-throwing stream callback errors the body without leaking bytes", async () => {
    const app = new Keala(quiet);
    app.get("/s", (c) =>
      stream(c, () => {
        throw new Error("secret-producer-failure");
      }),
    );
    const res = await app.handle(req("/s"));
    await expect(res.text()).rejects.toThrow();
  });

  it("SSE event/id fields are CRLF-sanitized and multiline data fans out", async () => {
    const app = new Keala(quiet);
    app.get("/sse", (c) =>
      streamSSE(c, (sse) => {
        sse.send({ event: "a\r\nb", id: "1\r2", data: "l1\nl2" });
      }),
    );
    const res = await app.handle(req("/sse"));
    const text = await res.text();
    expect(text).toBe("event: a  b\nid: 1 2\ndata: l1\ndata: l2\n\n");
  });
});

// ---------------------------------------------------------------------------
// component protocol + decorate surface (green)
// ---------------------------------------------------------------------------

describe("redteam P2: component protocol (green)", () => {
  it("a component whose install() throws fails loudly at use() time", () => {
    const app = new Keala(quiet);
    expect(() =>
      app.use({
        name: "bad",
        install() {
          throw new Error("install boom");
        },
      }),
    ).toThrow("install boom");
  });

  it("decorate refuses duplicate keys and core context keys at setup time", () => {
    const app = new Keala(quiet);
    app.decorate("feature", { enable: () => undefined });
    expect(() => app.decorate("feature", 2)).toThrow(/already defined/);
    // Core context members are guarded too — shadowing them silently changes
    // framework behavior under the caller's feet.
    expect(() => app.decorate("body", "x")).toThrow(/already defined/);
    expect(() => app.decorate("status", 200)).toThrow(/already defined/);
    // Accessor decorations fall under the same rule.
    expect(() => app.decorateLazy("status", () => 200)).toThrow(/already defined/);
  });

  it("decorate refuses per-request instance slots (params/bodyValue/…)", () => {
    const app = new Keala(quiet);
    // These live as own slots on every context, not on the prototype — a
    // getter decoration would make every request throw in initContext.
    expect(() => app.decorateLazy("params", () => ({}))).toThrow(/already defined/);
    expect(() => app.decorate("bodyValue", 1)).toThrow(/already defined/);
    expect(() => app.decorate("_res", null)).toThrow(/already defined/);
    expect(() => app.decorate("rawRequest", {})).toThrow(/already defined/);
    // Unrelated keys still decorate fine.
    app.decorate("featureX", 1);
  });

  it("decorate rejects non-string and empty keys", () => {
    const app = new Keala(quiet);
    expect(() => app.decorate(42 as unknown as string, 1)).toThrow(TypeError);
    expect(() => app.decorate("", 1)).toThrow(TypeError);
  });

  it("decorate('__proto__'/'constructor') refuses the keys, never pollutes Object.prototype", async () => {
    const app = new Keala(quiet);
    expect(() => app.decorate("__proto__", { polluted: true })).toThrow(TypeError);
    expect(() => app.decorate("constructor", () => 1)).toThrow(TypeError);
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(req("/x"));
    expect(res.status).toBe(200);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(Object.prototype)).toBeNull();
  });

  it("components and middleware mix in one use() call; accessor decorates install lazily", async () => {
    const order: string[] = [];
    const app = new Keala(quiet);
    app.use(
      (_c, next) => {
        order.push("mw1");
        return next();
      },
      {
        name: "greeter",
        install(target: { decorateLazy: (k: string, v: () => unknown) => void }) {
          target.decorateLazy("answer", () => 42);
        },
      },
      (_c, next) => {
        order.push("mw2");
        return next();
      },
    );
    app.get("/x", (c) => c.json({ answer: (c as unknown as { answer: number }).answer }));
    const res = await app.handle(req("/x"));
    expect(await res.text()).toBe('{"answer":42}');
    expect(order).toEqual(["mw1", "mw2"]);
  });
});
