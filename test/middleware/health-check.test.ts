/**
 * N6 healthCheck — liveness/readiness probe endpoints (k8s/Docker contract).
 *
 * The two probes answer different questions and must never collapse into
 * one: liveness says "the process is alive" (always 200 — wiring it to a
 * dependency check is how one bad dependency cascade-restarts the whole
 * service), readiness says "this instance may take traffic now" (503 with
 * a reason when the ready predicate says no or throws). Body format,
 * content-type, path customization, method scoping and fall-through are
 * all locked here.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { healthCheck } from "../../src/middleware/health-check.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost:3000${path}`, init);

const probeApp = (ready?: () => boolean | Promise<boolean>): Keala => {
  const app = new Keala(quiet);
  app.use(healthCheck(ready === undefined ? undefined : { ready }));
  app.get("/work", (c) => c.text("working"));
  return app;
};

const bodyOf = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

describe("healthCheck defaults", () => {
  it("liveness is always 200 — even while the ready predicate says no", async () => {
    const app = probeApp(() => false);
    const res = await app.handle(req("/healthz"));
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ status: "ok" });
  });

  it("readiness answers 200 {status:ok} when ready() is true", async () => {
    const app = probeApp(() => true);
    const res = await app.handle(req("/readyz"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await bodyOf(res)).toEqual({ status: "ok" });
  });

  it("readiness answers 503 {status:'not ready'} when ready() is false", async () => {
    const app = probeApp(() => false);
    const res = await app.handle(req("/readyz"));
    expect(res.status).toBe(503);
    expect(await bodyOf(res)).toEqual({ status: "not ready" });
  });

  it("an async ready predicate is awaited", async () => {
    const app = probeApp(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    });
    const res = await app.handle(req("/readyz"));
    expect(res.status).toBe(200);
  });

  it("a throwing ready() answers 503 with the error name, never the message", async () => {
    const app = probeApp((): boolean => {
      throw new Error("db password rejected for user root");
    });
    const res = await app.handle(req("/readyz"));
    expect(res.status).toBe(503);
    const body = await bodyOf(res);
    expect(body.status).toBe("not ready");
    expect(body.error).toBe("Error");
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("a non-Error thrown from ready() still yields a JSON 503", async () => {
    const app = probeApp((): boolean => {
      throw "strings are not errors"; // eslint-disable-line no-throw-literal
    });
    const res = await app.handle(req("/readyz"));
    expect(res.status).toBe(503);
    expect((await bodyOf(res)).status).toBe("not ready");
  });
});

describe("healthCheck wiring", () => {
  it("custom paths answer and the defaults no longer do", async () => {
    const app = new Keala(quiet);
    app.use(healthCheck({ livenessPath: "/live", readinessPath: "/ready" }));
    expect((await app.handle(req("/live"))).status).toBe(200);
    expect((await app.handle(req("/ready", { method: "GET" }))).status).toBe(200);
    expect((await app.handle(req("/healthz"))).status).toBe(404);
    expect((await app.handle(req("/readyz"))).status).toBe(404);
  });

  it("non-probe paths and non-GET methods fall through to the app", async () => {
    const app = probeApp(() => true);
    const work = await app.handle(req("/work"));
    expect(work.status).toBe(200);
    expect(await work.text()).toBe("working");
    // POST /healthz is not a probe answer — it falls through (404/405 land,
    // but never a synthetic 200).
    const post = await app.handle(req("/healthz", { method: "POST" }));
    expect(post.status).toBeGreaterThanOrEqual(400);
    expect(post.status).toBeLessThan(500);
  });

  it("HEAD on a probe path answers like GET (header-only view)", async () => {
    const app = probeApp(() => true);
    const res = await app.handle(new Request("http://localhost:3000/readyz", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe("");
  });
});
