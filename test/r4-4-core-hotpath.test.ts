import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { createBodyParser, type ContextWithBody } from "../src/plugins/body-parser.ts";

const request = (path = "/livez", init?: RequestInit): Request =>
  new Request(`http://localhost${path}`, init);

describe("R4.4 global-chain semantic locks", () => {
  for (const layers of [1, 3, 6]) {
    for (const asynchronous of [false, true]) {
      it(`${layers} ${asynchronous ? "async" : "sync"} layers preserve onion order`, async () => {
        const app = new Keala({ env: "production" });
        const order: string[] = [];
        for (let index = 0; index < layers; index++) {
          if (asynchronous) {
            app.use(async (_c, next) => {
              order.push(`before:${index}`);
              await next();
              order.push(`after:${index}`);
            });
          } else {
            app.use((_c, next) => {
              order.push(`before:${index}`);
              const downstream = next();
              order.push(`after:${index}`);
              return downstream;
            });
          }
        }
        app.get("/livez", (c) => {
          order.push("route");
          return c.json({ status: "ok" });
        });

        const response = await app.handle(request());
        expect(await response.json()).toEqual({ status: "ok" });
        expect(order).toEqual([
          ...Array.from({ length: layers }, (_, index) => `before:${index}`),
          "route",
          ...Array.from({ length: layers }, (_, offset) => `after:${layers - offset - 1}`),
        ]);
      });
    }
  }

  it("short-circuit and double-next behavior remain explicit", async () => {
    const short = new Keala({ env: "production" });
    let reached = false;
    short.use((c) => c.text("short"));
    short.get("/livez", () => {
      reached = true;
      return new Response("route");
    });
    expect(await (await short.handle(request())).text()).toBe("short");
    expect(reached).toBe(false);

    const doubled = new Keala({ env: "production" });
    doubled.onError((_error, c) => c.text("mapped", 500));
    doubled.use(async (_c, next) => {
      await next();
      await next();
    });
    doubled.get("/livez", (c) => c.text("route"));
    const response = await doubled.handle(request());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("mapped");
  });

  it("pooled async global chains do not cross request state", async () => {
    const app = new Keala({ env: "production", pooling: true });
    app.use(async (c, next) => {
      const id = c.header("x-id");
      c.state["id"] = id;
      await new Promise((resolve) => setTimeout(resolve, Number(id) % 3));
      await next();
    });
    app.get("/livez", (c) => c.text(String(c.state["id"])));

    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        app.handle(request("/livez", { headers: { "x-id": String(index) } })),
      ),
    );
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(
      Array.from({ length: 30 }, (_, index) => String(index)),
    );
  });
});

describe("R4.4 body-state semantic locks", () => {
  it("a recycled context creates a fresh facade and parsed value", async () => {
    const app = new Keala({ env: "production", pooling: true });
    app.use(createBodyParser({ jsonLimit: 128 }));
    const facades: unknown[] = [];
    const values: unknown[] = [];
    app.post("/echo", async (c0) => {
      const c = c0 as ContextWithBody;
      facades.push(c.req);
      const value = await c.req.json();
      values.push(value);
      return c.json(value);
    });

    for (const body of ['{"id":1}', '{"id":2}']) {
      const response = await app.handle(
        request("/echo", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
          },
          body,
        }),
      );
      expect(await response.json()).toEqual(JSON.parse(body));
    }
    expect(facades[0]).not.toBe(facades[1]);
    expect(values[0]).not.toBe(values[1]);
  });

  it("mixed concurrent readers share bytes while retaining reader identity", async () => {
    const app = new Keala({ env: "production" });
    app.use(createBodyParser({ jsonLimit: 128 }));
    app.post("/echo", async (c0) => {
      const c = c0 as ContextWithBody;
      const jsonA = c.req.json();
      const jsonB = c.req.json();
      const textA = c.req.text();
      const textB = c.req.text();
      const bytesA = c.req.arrayBuffer();
      const bytesB = c.req.arrayBuffer();
      const [json, text, bytes] = await Promise.all([jsonA, textA, bytesA]);
      return c.json({
        jsonPromise: jsonA === jsonB,
        textPromise: textA === textB,
        bytesPromise: bytesA === bytesB,
        value: json,
        text,
        bytes: bytes.byteLength,
      });
    });
    const body = '{"id":1}';
    const response = await app.handle(
      request("/echo", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(body.length) },
        body,
      }),
    );
    expect(await response.json()).toEqual({
      jsonPromise: true,
      textPromise: true,
      bytesPromise: true,
      value: { id: 1 },
      text: body,
      bytes: body.length,
    });
  });
});
