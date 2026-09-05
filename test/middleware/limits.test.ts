/**
 * Middleware kit tests: secureHeaders, requestId, timing, logger, cors, csrf,
 * etag, compress, bodyLimit, timeout and the html escape protocol.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { bodyLimit, timeout } from "../../src/middleware/limits.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

describe("bodyLimit + timeout", () => {
  it("bodyLimit passes bodyless requests through untouched", async () => {
    const app = new Keala(quiet);
    app.use(bodyLimit(10));
    app.get("/g", (c) => c.text("ok"));
    const res = await app.handle(req("/g"));
    expect([res.status, await res.text()]).toEqual([200, "ok"]);
  });

  it("bodyLimit rejects declared oversize with 413 before reading", async () => {
    const app = new Keala(quiet);
    app.use(bodyLimit(10));
    app.post("/x", (c) => c.text("ok"));
    const res = await app.handle(
      new Request("http://localhost:3000/x", {
        method: "POST",
        body: "0".repeat(64),
        headers: { "content-length": "64" },
      }),
    );
    expect(res.status).toBe(413);
  });

  it("bodyLimit validates its argument", () => {
    expect(() => bodyLimit(-1)).toThrow(TypeError);
  });

  it("timeout expires into an exposed 504; fast paths pass", async () => {
    const app = new Keala(quiet);
    app.get("/slow", timeout(10), async () => {
      await new Promise((r) => setTimeout(r, 60));
      return new Response("late");
    });
    const res = await app.handle(req("/slow"));
    expect(res.status).toBe(504);
    app.get("/fast", timeout(1000), (c) => c.text("fast"));
    expect((await app.handle(req("/fast"))).status).toBe(200);
    expect(() => timeout(0)).toThrow(TypeError);
  });
});
