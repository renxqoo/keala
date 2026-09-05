import { afterAll, describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { listen, type NodeServerHandle } from "../../src/adapters/node.ts";
import { validateHeaderName } from "../../src/utils/text.ts";

const quiet = { env: "test" } as const;
const servers: NodeServerHandle[] = [];

afterAll(() => {
  for (const server of servers) server.stop(true);
});

const serve = async (
  register: (app: InstanceType<typeof Keala>) => void,
): Promise<{ server: NodeServerHandle; base: string }> => {
  const app = new Keala(quiet);
  register(app);
  const server = await listen(app, 0, "127.0.0.1").ready();
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}` };
};

// The state-mode shapes exercised by the middleware-3 hot path: staged
// headers + a terminal state-style body, finalized through fromState with a
// non-empty header record.
const registerStateShapes = (app: InstanceType<typeof Keala>): void => {
  app.get("/text", (c) => {
    c.setHeader("x-step", "1");
    c.type = "text/plain";
    c.body = "middleware";
  });
  app.get("/json", (c) => {
    c.setHeader("x-step", "1");
    c.body = { hello: "world" };
  });
  app.get("/bytes", (c) => {
    c.setHeader("x-step", "1");
    c.body = new TextEncoder().encode("raw");
  });
};

describe("R4.7 fromState record paths (native and fetch sources)", () => {
  it("native adapter finalizes staged records for text, json and byte bodies", async () => {
    const { base } = await serve(registerStateShapes);

    const text = await fetch(`${base}/text`);
    expect(text.status).toBe(200);
    expect(text.headers.get("x-step")).toBe("1");
    expect(text.headers.get("content-type")?.startsWith("text/plain")).toBe(true);
    expect(await text.text()).toBe("middleware");

    const json = await fetch(`${base}/json`);
    expect(json.status).toBe(200);
    expect(json.headers.get("x-step")).toBe("1");
    // The record path backfills application/json on the wire.
    expect(json.headers.get("content-type")?.split(";")[0]).toBe("application/json");
    expect(await json.text()).toBe('{"hello":"world"}');

    const bytes = await fetch(`${base}/bytes`);
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("x-step")).toBe("1");
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(new TextEncoder().encode("raw"));
  });

  it("fetch-style handle() finalizes the same records through the Headers build", async () => {
    const app = new Keala(quiet);
    registerStateShapes(app);

    const text = await app.handle(new Request("http://localhost/text"));
    expect(text.headers.get("x-step")).toBe("1");
    expect(text.headers.get("content-type")?.startsWith("text/plain")).toBe(true);
    expect(await text.text()).toBe("middleware");

    const json = await app.handle(new Request("http://localhost/json"));
    expect(json.headers.get("content-type")?.split(";")[0]).toBe("application/json");
    expect(await json.text()).toBe('{"hello":"world"}');

    const bytes = await app.handle(new Request("http://localhost/bytes"));
    expect(bytes.headers.get("x-step")).toBe("1");
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(new TextEncoder().encode("raw"));
  });
});

describe("R4.7 staged-header wire behavior under repeated names", () => {
  it("rejects invalid names and accepts repeated valid ones across many calls", () => {
    // A large distinct-name vocabulary plus repeats: acceptance/rejection
    // must stay stable no matter how many names came before.
    for (let i = 0; i < 600; i++) validateHeaderName(`x-name-${i}`);
    expect(() => validateHeaderName("bad name")).toThrow(TypeError);
    expect(() => validateHeaderName("__proto__")).toThrow(TypeError);
    expect(() => validateHeaderName("")).toThrow(TypeError);
    validateHeaderName("x-after-many");
  });

  it("repeated names still reach the response wire", async () => {
    const { base } = await serve((app) => {
      app.get("/repeat", (c) => {
        c.setHeader("x-repeat", `v${c.url.length}`);
        c.body = "ok";
      });
    });
    const first = await fetch(`${base}/repeat`);
    const second = await fetch(`${base}/repeat`);
    expect(first.headers.get("x-repeat")).toBe("v7");
    expect(second.headers.get("x-repeat")).toBe("v7");
    expect(await second.text()).toBe("ok");
  });
});
