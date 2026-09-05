import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startNodeServer } from "../../src/adapters/node.ts";
import { Keala } from "../../src/core/app.ts";

const pipeline = (port: number): Promise<string> =>
  new Promise((resolve, reject) => {
    let output = "";
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        "GET /bad HTTP/1.1\r\nHost: test\r\n\r\n" +
          "GET /after HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n",
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("latin1");
    });
    socket.once("error", reject);
    socket.once("end", () => resolve(output));
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error("pipeline stalled"));
    });
  });

describe("B45-18 Node failure framing", () => {
  for (const mode of ["consumed", "locked", "producer-error"] as const) {
    it(`rejects ${mode} bodies with a fresh error envelope and preserves the next response`, async () => {
      const app = new Keala({ env: "test" });
      let reader: { releaseLock(): void } | undefined;
      app.get("/bad", async () => {
        const body =
          mode === "producer-error"
            ? new ReadableStream<Uint8Array>(
                {
                  pull() {
                    throw new Error("producer failed before first byte");
                  },
                },
                { highWaterMark: 0 },
              )
            : "secret-body";
        const response = new Response(body, {
          statusText: "Original",
          headers: {
            "content-length": "1000",
            "content-encoding": "gzip",
            "x-original": "secret",
          },
        });
        if (mode === "consumed") await response.text();
        if (mode === "locked") reader = response.body!.getReader();
        return response;
      });
      app.get("/after", (c) => c.text("after"));
      const server = await startNodeServer(app, { port: 0, hostname: "127.0.0.1" }).ready();
      try {
        const wire = await pipeline(server.port);
        const split = wire.indexOf("\r\n\r\n");
        const headers = wire.slice(0, split);
        const remainder = wire.slice(split + 4);
        expect(headers).toMatch(/^HTTP\/1\.1 500 Internal Server Error/);
        expect(headers).toMatch(/content-length: 21\r?$/im);
        expect(headers).not.toMatch(/content-encoding|x-original/i);
        expect(remainder).toMatch(/^Internal Server ErrorHTTP\/1\.1 200/);
        expect(remainder).toMatch(/\r\n\r\nafter$/);
      } finally {
        reader?.releaseLock();
        server.stop(true);
      }
    });
  }
});
