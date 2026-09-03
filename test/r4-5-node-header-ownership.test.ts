import { describe, expect, it } from "vitest";

import { startNodeServer } from "../src/adapters/node.ts";
import { Keala } from "../src/core/app.ts";
import { createBodyParser, type ContextWithBody } from "../src/plugins/body-parser.ts";
import { createPlannedResponse, inheritResponseFacts } from "../src/core/response-plan.ts";

describe("R4.5 Node request header ownership", () => {
  it("keeps bounded memoized body reads correct after headers materialization", async () => {
    const app = new Keala({ env: "test" });
    app.use(createBodyParser({ jsonLimit: 16 }));
    app.post("/body", async (c0) => {
      const c = c0 as ContextWithBody;
      const held = c.headers;
      held.set("x-observed", "yes");
      const value = await c.req.json();
      return c.json({
        value,
        memoized: value === (await c.req.json()),
        same: held === c.raw.headers,
        observed: c.get("x-observed"),
        used: c.raw.bodyUsed,
      });
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    try {
      for (const body of ['{"n":1}', JSON.stringify("x".repeat(32)), '{"n":1}']) {
        const response = await fetch(`http://127.0.0.1:${server.port}/body`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        if (body.length > 16) {
          expect(response.status).toBe(413);
          await response.arrayBuffer();
        } else {
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({
            value: { n: 1 },
            memoized: true,
            same: true,
            observed: "yes",
            used: true,
          });
        }
      }
    } finally {
      server.stop(true);
    }
  });

  it("does not resurrect content-type deleted from a native response carrying body facts", async () => {
    const app = new Keala({ env: "test" });
    app.get("/headers", () => {
      const response = inheritResponseFacts(
        new Response("body"),
        createPlannedResponse("body", {}, "text/plain; charset=utf-8"),
      );
      response.headers.delete("content-type");
      return response;
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/headers`);
      expect(response.headers.get("content-type")).toBeNull();
      expect(await response.text()).toBe("body");
    } finally {
      server.stop(true);
    }
  });
  it("B45-16: headers-first and raw-first share one mutable request-header source", async () => {
    const app = new Keala({ env: "test" });
    app.get("/headers/:order", (c) => {
      const held = c.params?.order === "raw" ? c.raw.headers : c.headers;
      held.set("x-mutable", "headers");
      const first = c.get("x-mutable");
      c.raw.headers.set("x-mutable", "raw");
      const second = c.get("x-mutable");
      c.headers.delete("x-mutable");
      return c.json({
        first,
        second,
        removed: c.get("x-mutable"),
        same: held === c.raw.headers && held === c.headers,
      });
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    try {
      for (const order of ["headers", "raw"]) {
        const response = await fetch(`http://127.0.0.1:${server.port}/headers/${order}`);
        expect(await response.json()).toEqual({
          first: "headers",
          second: "raw",
          removed: "",
          same: true,
        });
      }
    } finally {
      server.stop(true);
    }
  });
});
