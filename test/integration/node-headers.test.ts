import { describe, expect, it } from "vitest";

import { startNodeServer } from "../../src/adapters/node.ts";
import { Keala } from "../../src/core/app.ts";
import { bodyOf, createBodyParser } from "../../src/plugins/body-parser.ts";
import { createPlannedResponse, inheritResponseFacts } from "../../src/core/response-plan.ts";
import { Agent, request } from "node:http";
import { responseFactsOf } from "../../src/core/response-plan.ts";

describe("R4.5 Node request header ownership", () => {
  it("keeps bounded memoized body reads correct after headers materialization", async () => {
    const app = new Keala({ env: "test" });
    app.use(createBodyParser({ jsonLimit: 16 }));
    app.post("/body", async (c) => {
      const held = c.headers;
      held.set("x-observed", "yes");
      const value = await bodyOf(c).json();
      return c.json({
        value,
        memoized: value === (await bodyOf(c).json()),
        same: held === c.raw.headers,
        observed: c.header("x-observed"),
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
      const held = c.params.order === "raw" ? c.raw.headers : c.headers;
      held.set("x-mutable", "headers");
      const first = c.header("x-mutable");
      c.raw.headers.set("x-mutable", "raw");
      const second = c.header("x-mutable");
      c.headers.delete("x-mutable");
      return c.json({
        first,
        second,
        removed: c.header("x-mutable"),
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

describe("R4.5 Node validated header writes", () => {
  it("writes snapshots, cookies and Unicode bytes without materializing an unobserved plan", async () => {
    const app = new Keala({ env: "test" });
    const plans: Response[] = [];
    app.get("/:mode", (c) => {
      const headers = new Headers([
        ["X-Snapshot", "  before  "],
        ["set-cookie", "a=1; Path=/"],
        ["set-cookie", "b=2; Path=/"],
        ["content-length", "1000"],
      ]);
      const mode = c.params.mode;
      // A native clone is a foreign stream; its length is not construction
      // evidence the adapter can repair without consuming the stream.
      if (mode === "clone") headers.delete("content-length");
      if (mode === "empty-type") headers.set("content-type", "");
      const plan = createPlannedResponse("你好", { headers }, "text/plain; charset=utf-8");
      plans.push(plan);
      headers.set("x-snapshot", "after");
      if (mode === "observed") plan.headers.set("x-snapshot", "observed");
      if (mode === "deleted") plan.headers.delete("content-type");
      return mode === "clone" ? (plan.clone() as Response) : plan;
    });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    try {
      for (const mode of ["untouched", "observed", "deleted", "clone", "empty-type"]) {
        const response = await fetch(`http://127.0.0.1:${server.port}/${mode}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("x-snapshot")).toBe(
          mode === "observed" ? "observed" : "before",
        );
        expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
        expect(response.headers.get("content-type")).toBe(
          mode === "deleted" ? null : mode === "empty-type" ? "" : "text/plain; charset=utf-8",
        );
        if (mode !== "clone") {
          expect(response.headers.get("content-length")).toBe("6");
          expect(response.headers.has("transfer-encoding")).toBe(false);
        }
        expect(await response.text()).toBe("你好");
        if (mode === "untouched" || mode === "empty-type") {
          expect(responseFactsOf(plans.at(-1)!)?.native).toBeUndefined();
        }
      }
    } finally {
      server.stop(true);
    }
  });

  it("B45-H3: keeps one framing mode and reuses the connection after a stale declared length", async () => {
    const app = new Keala({ env: "test" });
    app.get(
      "/stream",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("你好"));
              controller.close();
            },
          }),
          { headers: { "content-length": "1000", "transfer-encoding": "chunked" } },
        ),
    );
    app.get("/:mode", (c) =>
      c.text("你好", 200, {
        "content-length": "1000",
        ...(c.params.mode === "chunked" ? { "transfer-encoding": "chunked" } : {}),
      }),
    );
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
    const read = (path: string): Promise<{ body: string; reused: boolean }> =>
      new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: server.port, path, agent }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.once("error", reject);
          res.once("end", () => {
            const chunked = res.headers["transfer-encoding"] !== undefined;
            if (
              res.statusCode !== 200 ||
              res.headers["content-length"] !== (chunked ? undefined : "6")
            ) {
              reject(new Error("invalid status or response framing"));
              return;
            }
            resolve({ body: Buffer.concat(chunks).toString(), reused: req.reusedSocket });
          });
        });
        req.once("error", reject);
        req.setTimeout(2000, () => req.destroy(new Error("response framing stalled")));
        req.end();
      });
    try {
      expect((await read("/fixed")).body).toBe("你好");
      expect(await read("/chunked")).toEqual({ body: "你好", reused: true });
      expect(await read("/stream")).toEqual({ body: "你好", reused: true });
      expect(await read("/fixed")).toEqual({ body: "你好", reused: true });
    } finally {
      agent.destroy();
      server.stop(true);
    }
  });
});
