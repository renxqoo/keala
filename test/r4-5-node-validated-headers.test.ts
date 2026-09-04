import { Agent, request } from "node:http";
import { describe, expect, it } from "vitest";
import { Keala } from "../src/core/app.ts";
import { startNodeServer } from "../src/adapters/node.ts";
import { createPlannedResponse, responseFactsOf } from "../src/core/response-plan.ts";

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
