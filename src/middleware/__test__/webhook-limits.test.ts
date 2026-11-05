import { createHmac } from "node:crypto";
import { request } from "node:http";
import { expect, it } from "vitest";
import { Keala, createBodyParser } from "../../index.ts";
import { listen } from "../../adapters/node.ts";
import { bodyLimit, webhook } from "../index.ts";

const options = {
  secret: "bounded-webhook-secret",
  header: "x-signature",
  format: "raw" as const,
  maxBodySize: 8,
};

it("rejects malformed webhook signatures before reading an untrusted body", async () => {
  let bytesRead = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        bytesRead += 4;
        controller.enqueue(new Uint8Array(4));
        if (bytesRead === 64) controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const app = new Keala({ env: "test" });
  app.post("/", webhook(options), (c) => c.text("accepted"));
  const response = await app.handle(
    new Request("http://test/", {
      method: "POST",
      headers: { "x-signature": "malformed" },
      body,
      duplex: "half",
    }),
  );
  expect(response.status).toBe(400);
  expect(bytesRead).toBe(0);
});

it("rejects stale webhook timestamps before reading their bodies", async () => {
  const timestamp = String(Math.floor(Date.now() / 1000) - 3600);
  const signature = createHmac("sha256", options.secret).update(`${timestamp}.data`).digest("hex");
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        controller.enqueue(new TextEncoder().encode("data"));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const app = new Keala({ env: "test" });
  app.post("/", webhook({ ...options, format: "stripe" }), (c) => c.text("accepted"));
  const response = await app.handle(
    new Request("http://test/", {
      method: "POST",
      headers: { "x-signature": `t=${timestamp},v1=${signature}` },
      body,
      duplex: "half",
    }),
  );
  expect([response.status, await response.text()]).toEqual([400, "Stale webhook timestamp"]);
  expect(reads).toBe(0);
});

it.each([undefined, "1"])(
  "stops and cancels oversized webhook streams with Content-Length %s",
  async (declared) => {
    let bytesRead = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bytesRead += 4;
          controller.enqueue(new Uint8Array(4));
          if (bytesRead === 256) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const app = new Keala({ env: "test" });
    app.use(createBodyParser({ jsonLimit: 8, textLimit: 8, formLimit: 8 }));
    app.use(bodyLimit(8));
    app.post("/", webhook(options), (c) => c.text("accepted"));
    const response = await app.handle(
      new Request("http://test/", {
        method: "POST",
        headers: {
          "x-signature": "00".repeat(32),
          ...(declared === undefined ? {} : { "content-length": declared }),
        },
        body,
        duplex: "half",
      }),
    );
    expect(response.status).toBe(413);
    expect(bytesRead).toBeLessThan(256);
    await expect.poll(() => cancelled).toBe(true);
  },
);

it("bounds webhook bodies to one MiB by default without a body-parser plugin", async () => {
  const app = new Keala({ env: "test" });
  app.post("/", webhook({ secret: options.secret, header: options.header, format: "raw" }), (c) =>
    c.text("accepted"),
  );
  const response = await app.handle(
    new Request("http://test/", {
      method: "POST",
      headers: { "x-signature": "00".repeat(32) },
      body: new Uint8Array(1024 * 1024 + 1),
    }),
  );
  expect(response.status).toBe(413);
});

it("preserves a signed body exactly at the configured webhook limit for downstream readers", async () => {
  const body = Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 255);
  const signature = createHmac("sha256", options.secret).update(body).digest("hex");
  const app = new Keala({ env: "test" });
  app.post("/", webhook(options), async (c) =>
    c.text(Buffer.from(await c.raw.arrayBuffer()).toString("hex")),
  );
  const response = await app.handle(
    new Request("http://test/", {
      method: "POST",
      headers: { "x-signature": signature },
      body,
    }),
  );
  expect([response.status, await response.text()]).toEqual([200, "00010203040506ff"]);
});

it("answers 413 over real HTTP before an oversized chunked webhook upload ends", async () => {
  const app = new Keala({ env: "test" });
  app.post("/", webhook(options), (c) => c.text("accepted"));
  const server =
    typeof Bun === "undefined"
      ? await listen(app, { port: 0, hostname: "127.0.0.1" }).ready()
      : app.listen({ port: 0, hostname: "127.0.0.1" });
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: server.port,
          path: "/",
          method: "POST",
          headers: { "x-signature": "00".repeat(32) },
        },
        (response) => {
          response.resume();
          response.on("end", () => {
            clearTimeout(timer);
            resolve(response.statusCode);
            req.destroy();
          });
          response.on("error", reject);
        },
      );
      const timer = setTimeout(
        () => req.destroy(new Error("webhook did not answer before EOF")),
        1000,
      );
      req.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      req.write(Buffer.alloc(32));
    });
    expect(status).toBe(413);
  } finally {
    await app.close({ drain: 100 });
  }
});

it("rejects oversized declared webhook bodies before the producer is pulled", async () => {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(16));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const app = new Keala({ env: "test" });
  app.post("/", webhook(options), (c) => c.text("accepted"));
  const response = await app.handle(
    new Request("http://test/", {
      method: "POST",
      headers: { "x-signature": "00".repeat(32), "content-length": "16" },
      body,
      duplex: "half",
    }),
  );
  expect(response.status).toBe(413);
  expect(reads).toBe(0);
});

it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid webhook byte budgets %s at setup",
  (maxBodySize) => {
    expect(() => webhook({ ...options, maxBodySize })).toThrow(TypeError);
  },
);

it("allows an empty signed webhook at a zero-byte budget and rejects nonempty bodies", async () => {
  const app = new Keala({ env: "test" });
  app.post("/", webhook({ ...options, maxBodySize: 0 }), (c) => c.text("accepted"));
  for (const [body, status] of [
    ["", 200],
    ["x", 413],
  ] as const) {
    const signature = createHmac("sha256", options.secret).update(body).digest("hex");
    const response = await app.handle(
      new Request("http://test/", {
        method: "POST",
        headers: { "x-signature": signature },
        body,
      }),
    );
    expect(response.status).toBe(status);
  }
});

it("does not wait for an uncooperative producer's cancellation before rejecting an oversized webhook", async () => {
  let releaseCancel!: () => void;
  const cancellation = new Promise<void>((resolve) => (releaseCancel = resolve));
  let bytesRead = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        bytesRead += 4;
        controller.enqueue(new Uint8Array(4));
        if (bytesRead === 256) controller.close();
      },
      cancel() {
        return cancellation;
      },
    },
    { highWaterMark: 0 },
  );
  const app = new Keala({ env: "test" });
  app.post("/", webhook(options), (c) => c.text("accepted"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      app.handle(
        new Request("http://test/", {
          method: "POST",
          headers: { "x-signature": "00".repeat(32) },
          body,
          duplex: "half",
        }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("webhook waited for cancellation")), 1000);
      }),
    ]);
    expect(response.status).toBe(413);
  } finally {
    clearTimeout(timer);
    releaseCancel();
  }
});
