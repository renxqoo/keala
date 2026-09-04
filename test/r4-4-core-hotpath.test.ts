import { describe, expect, it } from "vitest";

import { Keala } from "../src/core/app.ts";
import { bodyOf, createBodyParser, readBodyLimited } from "../src/plugins/body-parser.ts";

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
    app.post("/echo", async (c) => {
      facades.push(bodyOf(c));
      const value = await bodyOf(c).json();
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
    app.post("/echo", async (c) => {
      const jsonA = bodyOf(c).json();
      const jsonB = bodyOf(c).json();
      const textA = bodyOf(c).text();
      const textB = bodyOf(c).text();
      const bytesA = bodyOf(c).arrayBuffer();
      const bytesB = bodyOf(c).arrayBuffer();
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

  it("concurrent reader types trigger exactly one native body consumption", async () => {
    const app = new Keala({ env: "production" });
    app.use(createBodyParser({ jsonLimit: 128 }));
    app.post("/echo", async (c) => {
      const [json, text, bytes] = await Promise.all([
        bodyOf(c).json(),
        bodyOf(c).text(),
        bodyOf(c).arrayBuffer(),
      ]);
      return c.json({ json, text, bytes: bytes.byteLength });
    });

    const body = '{"id":1}';
    const raw = request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    }) as Request & { bytes(): Promise<Uint8Array> };
    const nativeBytes = raw.bytes.bind(raw);
    let reads = 0;
    Object.defineProperty(raw, "bytes", {
      value: (): Promise<Uint8Array> => {
        reads += 1;
        return nativeBytes();
      },
    });

    const response = await app.handle(raw);
    expect(await response.json()).toEqual({ json: { id: 1 }, text: body, bytes: body.length });
    expect(reads).toBe(1);
  });

  it("direct bounded readers reuse equal/larger budgets and recheck smaller budgets", async () => {
    const app = new Keala({ env: "production" });
    app.post("/read", async (c) => {
      const first = readBodyLimited(c, 16);
      const larger = readBodyLimited(c, 32);
      const bytes = await first;
      let smallerStatus = 0;
      try {
        await readBodyLimited(c, 2);
      } catch (error) {
        smallerStatus = (error as { status?: number }).status ?? 0;
      }
      return c.json({ samePromise: first === larger, bytes: bytes.byteLength, smallerStatus });
    });
    const body = "abc";
    const response = await app.handle(
      request("/read", {
        method: "POST",
        headers: { "content-length": String(body.length) },
        body,
      }),
    );
    expect(await response.json()).toEqual({ samePromise: true, bytes: 3, smallerStatus: 413 });
  });
});
