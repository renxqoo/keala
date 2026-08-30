/**
 * bodyParser + validator component tests: readers, memoization, limits
 * (declared and streamed), malformed input and validation failures.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/core/app.ts";
import { createBodyParser, type ContextWithBody } from "../src/components/body-parser.ts";
import {
  validator,
  type ContextWithValid,
  type StandardSchema,
} from "../src/components/validator.ts";
import type { RouteHandler } from "../src/router/router.ts";

const quiet = { env: "test" } as const;
const post = (
  body: string | FormData | ReadableStream,
  headers: Record<string, string> = {},
): Request => new Request("http://localhost:3000/x", { method: "POST", body, headers });

const jsonBody = (value: unknown, headers: Record<string, string> = {}): Request =>
  post(JSON.stringify(value), { "content-type": "application/json", ...headers });

describe("bodyParser: readers", () => {
  it("json/text/arrayBuffer/blob read the memoized body", async () => {
    const app = createApp(quiet);
    app.use(createBodyParser());
    let order: string[] = [];
    app.post("/x", async (c0) => {
      const c = c0 as ContextWithBody;
      order = [];
      const json = (await c.req.json()) as { a: number };
      order.push("json");
      const text = await c.req.text();
      order.push("text");
      const bytes = await c.req.arrayBuffer();
      order.push("bytes");
      const blob = await c.req.blob();
      order.push("blob");
      c.body = `${json.a}|${text}|${bytes.byteLength}|${blob.size}`;
    });
    const res = await app.handle(jsonBody({ a: 1 }));
    expect(await res.text()).toBe('1|{"a":1}|7|7');
    expect(order).toEqual(["json", "text", "bytes", "blob"]);
  });

  it("multiple middleware+handler reads share one body consumption", async () => {
    const app = createApp(quiet);
    app.use(createBodyParser());
    app.post("/x", async (c0, next) => {
      const c = c0 as ContextWithBody;
      c.state.first = await c.req.text();
      await next();
    });
    app.post("/x", async (c0) => {
      const c = c0 as ContextWithBody;
      c.body = `${c.state.first as string}/${await c.req.text()}`;
    });
    const res = await app.handle(post("payload"));
    expect(await res.text()).toBe("payload/payload");
  });

  it("empty bodies: json -> null, text -> empty string", async () => {
    const app = createApp(quiet);
    app.use(createBodyParser());
    app.post("/x", async (c0) => {
      const c = c0 as ContextWithBody;
      c.body = JSON.stringify([await c.req.json(), await c.req.text()]);
    });
    const res = await app.handle(post(""));
    expect(await res.text()).toBe('[null,""]');
  });

  it("urlencoded and multipart formData parse", async () => {
    const app = createApp(quiet);
    app.use(createBodyParser());
    app.post("/x", async (c0) => {
      const c = c0 as ContextWithBody;
      const form = await c.req.formData();
      c.body = JSON.stringify([form.get("a"), form.get("b")]);
    });
    const urlenc = await app.handle(
      post("a=1&b=2", { "content-type": "application/x-www-form-urlencoded" }),
    );
    expect(await urlenc.text()).toBe('["1","2"]');
    const form = new FormData();
    form.set("a", "x");
    form.set("b", "y");
    const multi = await app.handle(post(form));
    expect(await multi.text()).toBe('["x","y"]');
  });
});

describe("bodyParser: limits and malformed input", () => {
  it("declared Content-Length over the limit fails fast with 413", async () => {
    const app = createApp(quiet);
    app.use(createBodyParser({ jsonLimit: 8 }));
    app.post("/x", async (c0) => {
      const c = c0 as ContextWithBody;
      c.body = JSON.stringify(await c.req.json());
    });
    const res = await app.handle(jsonBody({ padding: "0123456789" }));
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("exceeds");
  });

  it("streamed bodies over the limit abort at the boundary (no Content-Length)", async () => {
    const app = createApp(quiet);
    app.use(createBodyParser({ jsonLimit: 16 }));
    app.post("/x", async (c0) => {
      const c = c0 as ContextWithBody;
      c.body = JSON.stringify(await c.req.json());
    });
    const chunks = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"pad":"`));
        controller.enqueue(new TextEncoder().encode("0".repeat(64)));
        controller.enqueue(new TextEncoder().encode(`"}`));
        controller.close();
      },
    });
    const res = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "POST",
        body: chunks,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
  });

  it("malformed JSON answers an exposed 400", async () => {
    const app = createApp(quiet);
    app.use(createBodyParser());
    app.post("/x", async (c0) => {
      const c = c0 as ContextWithBody;
      c.body = JSON.stringify(await c.req.json());
    });
    const res = await app.handle(post("{not json", { "content-type": "application/json" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("request body is not valid JSON");
  });
});

describe("validator", () => {
  const schemaOk = (valid: boolean): StandardSchema => ({
    "~standard": {
      version: 1,
      validate: (value: unknown) =>
        valid
          ? { value: { doubled: (value as { n: number }).n * 2 } }
          : { issues: [{ message: "n must be a number", path: ["n"] }] },
    },
  });

  it("rejects non Standard Schema inputs at construction", () => {
    expect(() => validator({} as StandardSchema)).toThrow(/Standard Schema/);
  });

  it("valid bodies populate c.valid; handlers run after", async () => {
    const app = createApp(quiet);
    const ran: string[] = [];
    const mw: RouteHandler = async (_c, next) => {
      ran.push("next");
      await next();
    };
    app.post("/x", mw, validator(schemaOk(true)), (c0) => {
      const c = c0 as ContextWithValid;
      c.body = JSON.stringify(c.valid);
    });
    const res = await app.handle(jsonBody({ n: 21 }));
    expect(await res.text()).toBe('{"doubled":42}');
    expect(ran).toEqual(["next"]);
  });

  it("invalid bodies answer an exposed 400 listing issues", async () => {
    const app = createApp(quiet);
    let reached = false;
    app.post("/x", validator(schemaOk(false)), () => {
      reached = true;
      return new Response("never");
    });
    const res = await app.handle(jsonBody({ n: "nope" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("n must be a number at n");
    expect(reached).toBe(false);
  });

  it("empty bodies validate null; malformed JSON answers 400", async () => {
    const app = createApp(quiet);
    const echoNull: StandardSchema = {
      "~standard": {
        version: 1,
        validate: (value) => ({ value }),
      },
    };
    app.post("/x", validator(echoNull), (c0) => {
      const c = c0 as ContextWithValid;
      c.body = JSON.stringify(c.valid);
    });
    const empty = await app.handle(post(""));
    expect(await empty.text()).toBe("null");
    app.post("/y", validator(schemaOk(true)), () => undefined);
    const bad = await app.handle(post("{oops", { "content-type": "application/json" }));
    expect(bad.status).toBe(400);
  });
});
