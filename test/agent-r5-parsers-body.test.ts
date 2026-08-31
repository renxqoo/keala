/**
 * ROUND 5 PARSER AUDIT — body/validator locks (bodyParser limits & budgets,
 * validator alignment). Split from agent-r5-parsers.test.ts.
 */

import { describe, expect, it } from "vitest";

import { Honu } from "../src/core/app.ts";
import { createBodyParser } from "../src/plugins/body-parser.ts";
import { validator, type ContextWithValid } from "../src/middleware/validator.ts";
import type { Context } from "../src/core/context/context.ts";

const quiet = { env: "test" } as const;
const drive = (app: InstanceType<typeof Honu>, req: Request) => app.handle(req);

describe("bodyParser locks correct behavior", () => {
  it("a second reader with a SMALLER limit 413s even on cached bytes", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser({ jsonLimit: 5, formLimit: 1000 }));
    app.post("/", async (c) => {
      const f = await (c as unknown as { req: { formData(): Promise<FormData> } }).req.formData();
      let err = "";
      try {
        await (c as unknown as { req: { json(): Promise<unknown> } }).req.json();
      } catch (e) {
        err = `${(e as { status?: number }).status}`;
      }
      return c.text(`f=${f.get("a")} err=${err}`);
    });
    const res = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=12345678",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("f=12345678 err=413");
  });

  it("multiple readers share the memoized bytes", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser());
    app.post("/", async (c) => {
      const req = (c as unknown as { req: { text(): Promise<string>; json(): Promise<unknown> } })
        .req;
      const t = await req.text();
      const j = await req.json();
      return c.text(`${t}/${JSON.stringify(j)}`);
    });
    const res = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      }),
    );
    expect(await res.text()).toBe('{"a":1}/{"a":1}');
  });

  it("arrayBuffer/blob share the json limit (one byte budget for data readers)", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser({ jsonLimit: 4 }));
    app.post("/", async (c) => {
      const req = (c as unknown as { req: { arrayBuffer(): Promise<Uint8Array> } }).req;
      try {
        const bytes = await req.arrayBuffer();
        return c.text(String(bytes.byteLength));
      } catch (e) {
        return c.text("413", (e as { status?: number }).status ?? 500);
      }
    });
    const res = await drive(app, new Request("http://x/", { method: "POST", body: "123456" }));
    expect(res.status).toBe(413);
  });

  it("a declared content-length below the real streamed size is caught while reading", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser({ jsonLimit: 10 }));
    app.post("/", async (c) => {
      const req = (c as unknown as { req: { text(): Promise<string> } }).req;
      return c.text(await req.text());
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("0123456789"));
        controller.enqueue(new TextEncoder().encode("ABCDEFGHIJ")); // 20 total
        controller.close();
      },
    });
    const res = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-length": "5", "content-type": "text/plain" },
        body: stream,
        duplex: "half",
      }),
    );
    expect(res.status).toBe(413);
  });

  it("a declared content-length above the real size reads to completion", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser({ jsonLimit: 100 }));
    app.post("/", async (c) => {
      const req = (c as unknown as { req: { text(): Promise<string> } }).req;
      return c.text(String((await req.text()).length));
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.close();
      },
    });
    const res = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-length": "50" },
        body: stream,
        duplex: "half",
      }),
    );
    expect(await res.text()).toBe("3");
  });

  it("an oversized DECLARED length fails fast before any read", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser({ jsonLimit: 8 }));
    app.post("/", async (c) => {
      const req = (c as unknown as { req: { text(): Promise<string> } }).req;
      return c.text(await req.text());
    });
    const res = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-length": "999999" },
        body: "tiny",
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("999999");
  });

  it("json() of an empty body is null, not a parse error", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser());
    app.post("/", async (c) => {
      const req = (c as unknown as { req: { json(): Promise<unknown> } }).req;
      return c.json({ v: await req.json() });
    });
    const res = await drive(app, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ v: null });
  });

  it("urlencoded part budget: separators+1 against the limit", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser({ formPartLimit: 5 }));
    app.post("/", async (c) => {
      const req = (c as unknown as { req: { formData(): Promise<FormData> } }).req;
      const f = await req.formData();
      return c.text(String([...f.keys()].length));
    });
    const ok = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1&b=2&c=3&d=4&e=5", // 5 parts
      }),
    );
    expect(await ok.text()).toBe("5");
    const over = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1&b=2&c=3&d=4&e=5&f=6", // 6 parts
      }),
    );
    expect(over.status).toBe(413);
  });

  it("multipart budget: quoted boundary containing ';' is honored (parts = occurrences-1)", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser({ formPartLimit: 2 }));
    app.post("/", async (c) => {
      const req = (c as unknown as { req: { formData(): Promise<FormData> } }).req;
      const f = await req.formData();
      return c.text(String(f.get("a")));
    });
    const body = [
      '--X;Y\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n',
      '--X;Y\r\nContent-Disposition: form-data; name="b"\r\n\r\n2\r\n',
      '--X;Y\r\nContent-Disposition: form-data; name="c"\r\n\r\n3\r\n',
      "--X;Y--\r\n",
    ].join("");
    const res = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": 'multipart/form-data; boundary="X;Y"' },
        body,
      }),
    );
    // 4 occurrences of --X;Y → 3 parts > 2 → 413.
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("3 parts");
  });

  it("multipart with zero delimiter hits skips the budget (runtime answers 400)", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser({ formPartLimit: 1 }));
    app.post("/", async (c) => {
      const req = (c as unknown as { req: { formData(): Promise<FormData> } }).req;
      try {
        await req.formData();
        return c.text("ok");
      } catch (e) {
        return c.text("e", (e as { status?: number }).status ?? 500);
      }
    });
    const res = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=NOPE" },
        body: "garbage-no-delims",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("installing the plugin twice fails loudly (decorate collision guard)", () => {
    const app = new Honu(quiet);
    app.use(createBodyParser());
    expect(() => app.use(createBodyParser())).toThrow(TypeError);
  });

  it("textLimit is independent of jsonLimit", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser({ textLimit: 3, jsonLimit: 1000 }));
    app.post("/", async (c) => {
      const req = (c as unknown as { req: { text(): Promise<string> } }).req;
      try {
        return c.text(await req.text());
      } catch (e) {
        return c.text("413", (e as { status?: number }).status ?? 500);
      }
    });
    const res = await drive(app, new Request("http://x/", { method: "POST", body: "toolong" }));
    expect(res.status).toBe(413);
  });

  it("rejects negative limits at construction, allows zero", () => {
    expect(() => createBodyParser({ jsonLimit: -1 })).toThrow(TypeError);
    expect(() => createBodyParser({ formPartLimit: -1 })).toThrow(TypeError);
    expect(() => createBodyParser({ jsonLimit: 0 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validator — locks correct behavior
// ---------------------------------------------------------------------------

describe("validator locks correct behavior", () => {
  type ValidateResult = { value?: unknown } | { issues: unknown[] };
  const schemaOf = (validate: (value: unknown) => ValidateResult | Promise<ValidateResult>) => ({
    "~standard": { version: 1 as const, validate },
  });

  it("an empty body validates null (bytes.length === 0 → parsed = null)", async () => {
    let seen: unknown = "unset";
    const app = new Honu(quiet);
    app.post(
      "/",
      validator(
        schemaOf((v) => {
          seen = v;
          return { value: v };
        }),
      ),
      (c) => c.text(JSON.stringify(seen)),
    );
    const res = await drive(app, new Request("http://x/", { method: "POST" }));
    expect(await res.text()).toBe("null");
  });

  it("aligns its read limit with the app's bodyJsonLimit", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser({ jsonLimit: 8 }));
    app.post("/", validator(schemaOf(() => ({ value: 1 }))), (c) => c.text("ok"));
    const ok = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":12}', // exactly 8 bytes
      }),
    );
    expect(await ok.text()).toBe("ok");
    const over = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":123}', // 9 bytes
      }),
    );
    expect(over.status).toBe(413);
  });

  it("defaults to 1MB when no bodyParser is installed", async () => {
    const app = new Honu(quiet);
    app.post("/", validator(schemaOf(() => ({ value: 1 }))), (c) => c.text("ok"));
    const res = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      }),
    );
    expect(await res.text()).toBe("ok");
  });

  it("malformed JSON short-circuits with an exposed 400", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser());
    app.post("/", validator(schemaOf(() => ({ value: 1 }))), (c) => c.text("ok"));
    const res = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "nope",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("a rejected validate() promise surfaces as 5xx, never as a pass", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser());
    app.post("/", validator(schemaOf(() => Promise.reject(new Error("schema exploded")))), (c) =>
      c.text("unreachable"),
    );
    const res = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      }),
    );
    expect(res.status).toBe(500);
  });

  it("issues render as a 400 listing messages and paths", async () => {
    const app = new Honu(quiet);
    app.use(createBodyParser());
    app.post(
      "/",
      validator(
        schemaOf(() => ({
          issues: [{ message: "too small", path: ["a", 0] }, { message: "bad" }],
        })),
      ),
      (c) => c.text("unreachable"),
    );
    const res = await drive(
      app,
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("too small at a.0; bad");
  });

  it("c.valid installs once per app and stays app-isolated", async () => {
    const app1 = new Honu(quiet);
    const app2 = new Honu(quiet);
    // c.valid is a decorated getter (installed by validator at request time).
    const validOf = (c: Context) => String((c as ContextWithValid).valid);
    app1.post("/", validator(schemaOf(() => ({ value: "one" }))), (c) => c.text(validOf(c)));
    app2.post("/", validator(schemaOf(() => ({ value: "two" }))), (c) => c.text(validOf(c)));
    const one = await drive(app1, new Request("http://x/", { method: "POST", body: "{}" }));
    const two = await drive(app2, new Request("http://x/", { method: "POST", body: "{}" }));
    expect([await one.text(), await two.text()]).toEqual(["one", "two"]);
  });
});
