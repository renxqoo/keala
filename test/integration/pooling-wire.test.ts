/**
 * Pooling wire contract — the retire fast path must leave direct-body
 * responses byte-identical to the no-pooling server on the real HTTP surface
 * of both runtimes.
 *
 * The Bun leg is the regression gate for serve-time string MIME inference:
 * `new Response(string)` carries empty Headers on Bun (the runtime infers
 * text/plain when it serves the string body), and the retireWithBody
 * consumption wrapper used to replace that body with a ReadableStream —
 * pooled /text answered 200 with NO content-type (R4.7 pooling A/B, first
 * matrix run). The Node leg covers the native-source direct-write path,
 * which carried zero pooling coverage before this suite.
 */

import { afterAll, describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import type { Context } from "../../src/core/context/context.ts";
import { startNodeServer } from "../../src/adapters/node.ts";

/** The hot-matrix endpoint shapes (bench/server-keala.ts, minus metrics). */
const registerRoutes = (app: InstanceType<typeof Keala>): void => {
  app.get("/livez", (c) => c.json({ status: "ok" }));
  app.get("/text", (c) => c.text("hello world"));
  app.get("/json", (c) => c.json({ hello: "world" }));
  app.get("/users/:id", (c) => c.text(`user ${c.params("id")}`));
  app.get("/async-json", async (c) => c.json({ async: true }));
  app.get(
    "/mw",
    async (c, next) => {
      c.setHeader("X-Step", "1");
      await next();
      c.setHeader("X-Step-3", "3");
    },
    (c: Context) => {
      c.setHeader("Content-Type", "text/plain; charset=utf-8");
      return c.text("middleware");
    },
  );
};

/** The wire facts a pooling regression can corrupt. */
const wireOf = async (url: string): Promise<Record<string, unknown>> => {
  const res = await fetch(url);
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: await res.text(),
    xStep: res.headers.get("x-step"),
  };
};

const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

describe("pooling wire parity", () => {
  it.skipIf(typeof Bun === "undefined")(
    "Bun.serve: pooled direct-body responses match the no-pooling server byte for byte",
    { timeout: 10_000 },
    async () => {
      const pooledApp = new Keala({ env: "test", pooling: true });
      registerRoutes(pooledApp);
      const pooled = pooledApp.listen(0);
      servers.push(pooled);

      const plainApp = new Keala({ env: "test" });
      registerRoutes(plainApp);
      const plain = plainApp.listen(0);
      servers.push(plain);

      const pooledBase = `http://127.0.0.1:${pooled.port}`;
      const plainBase = `http://127.0.0.1:${plain.port}`;
      // Two passes over the pooled server: the second request rides a
      // recycled context — a stale retire hint or missed reset would only
      // show up there.
      for (const path of ["/livez", "/text", "/json", "/users/7", "/async-json", "/mw"]) {
        const expected = JSON.stringify(await wireOf(`${plainBase}${path}`));
        for (let pass = 0; pass < 2; pass++) {
          expect(JSON.stringify(await wireOf(`${pooledBase}${path}`)), `${path} pass ${pass}`).toBe(
            expected,
          );
        }
      }

      // A streaming body keeps the consumption-tracking wrapper — it must
      // still serve correctly under pooling.
      const pooledStream = new Keala({ env: "test", pooling: true });
      pooledStream.get(
        "/stream",
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("streamed"));
                controller.close();
              },
            }),
          ),
      );
      const streamServer = pooledStream.listen(0);
      servers.push(streamServer);
      const streamed = await fetch(`http://127.0.0.1:${streamServer.port}/stream`);
      expect(streamed.status).toBe(200);
      expect(await streamed.text()).toBe("streamed");
    },
  );

  it(
    "node adapter: pooled native-source responses match the no-pooling server",
    { timeout: 10_000 },
    async () => {
      const pooledApp = new Keala({ env: "test", pooling: true });
      registerRoutes(pooledApp);
      const pooled = await startNodeServer(pooledApp, { port: 0, hostname: "127.0.0.1" }).ready();
      servers.push(pooled);

      const plainApp = new Keala({ env: "test" });
      registerRoutes(plainApp);
      const plain = await startNodeServer(plainApp, { port: 0, hostname: "127.0.0.1" }).ready();
      servers.push(plain);

      const pooledBase = `http://127.0.0.1:${pooled.port}`;
      const plainBase = `http://127.0.0.1:${plain.port}`;
      for (const path of ["/livez", "/text", "/json", "/users/7", "/async-json", "/mw"]) {
        const expected = JSON.stringify(await wireOf(`${plainBase}${path}`));
        expect(JSON.stringify(await wireOf(`${pooledBase}${path}`)), path).toBe(expected);
      }
      // The planned direct-write path derives the implicit content types
      // from response facts — pin them so a wrapper regression
      // (octet-stream / missing CT) cannot slip through.
      expect((await wireOf(`${pooledBase}/text`)).contentType).toMatch(/^text\/plain/);
      expect((await wireOf(`${pooledBase}/json`)).contentType).toMatch(/^application\/json/);
    },
  );

  it("app.handle: pooled and non-pooled responses expose identical headers", async () => {
    const pooled = new Keala({ env: "test", pooling: true });
    const plain = new Keala({ env: "test" });
    for (const app of [pooled, plain]) {
      app.get("/text", (c) => c.text("same"));
      app.get("/json", (c) => c.json({ same: true }));
      // 0.7: a post-commit body write throws now; the surviving in-place
      // post-commit mutation is the header write — that path must stay
      // pooling-parity too.
      app.get("/late", (c) => {
        const res = c.text("first");
        c.setHeader("x-late", "1");
        return res;
      });
    }
    for (const path of ["/text", "/json", "/late"]) {
      const pooledResponse = await pooled.handle(new Request(`http://localhost:3000${path}`));
      const plainResponse = await plain.handle(new Request(`http://localhost:3000${path}`));
      expect(await pooledResponse.text()).toBe(await plainResponse.text());
      expect(pooledResponse.headers.get("content-type")).toBe(
        plainResponse.headers.get("content-type"),
      );
      expect(pooledResponse.headers.get("x-late")).toBe(plainResponse.headers.get("x-late"));
      expect(pooledResponse.status).toBe(plainResponse.status);
      expect(pooledResponse.statusText).toBe(plainResponse.statusText);
    }
  });
});
