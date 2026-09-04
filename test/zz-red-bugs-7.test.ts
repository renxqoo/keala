/**
 * zz-red-bugs-7 — PLAUSIBLE findings verification.
 */
import { describe, expect, it } from "vitest";
import { Keala } from "../src/index.ts";

const hit = async (
  app: InstanceType<typeof Keala>,
  path: string,
  init?: RequestInit,
): Promise<Response> => app.handle(new Request(`http://localhost${path}`, init));

describe("P1: direct() chain has no double-next() guard", () => {
  it("composed chains throw on double next(); single-handler routes do too", async () => {
    const composed = new Keala({ env: "test" });
    composed.use((_c, next) => {
      void next();
      return next();
    });
    composed.get("/x", (c) => c.text("x"));
    const composedRes = await hit(composed, "/x");
    expect(composedRes.status).toBe(500); // guarded — loud

    // EXPECTED behavior (compose direct() fix, BUG-4): a single-handler
    // route's second next() must trip the SAME guard the composed path has
    // — never resolve silently. Probed through the error funnel so the
    // assertion holds whether the guard throws synchronously or rejects.
    const direct = new Keala({ env: "test" });
    let nextCalls = 0;
    let guardMessage: string | null = null;
    direct.onError((e) => {
      guardMessage = e.message;
      return undefined;
    });
    direct.get("/y", (_c, next) => {
      void next().then(() => {
        nextCalls++;
      });
      nextCalls++;
      return next(); // second call — must fail loud, not silently no-op
    });
    const directRes = await hit(direct, "/y");
    expect(directRes.status).toBe(500);
    expect(guardMessage).toContain("next() called multiple times");
    expect(nextCalls).toBe(2); // the FIRST next() still settled once
  });
});

describe("P2: a later static registration shadows an earlier dynamic route for ALL methods", () => {
  it("GET /users/7 flips from 200 to 405 after POST /users/7 registers", async () => {
    const app = new Keala({ env: "test" });
    app.get("/users/:id", (c) => c.text(`id:${c.params.id}`));
    expect((await hit(app, "/users/7")).status).toBe(200);
    app.post("/users/7", (c) => c.text("posted"));
    const after = await hit(app, "/users/7");
    expect([after.status, after.headers.get("allow")]).toEqual([405, "POST"]);
    // koa-router registration-order semantics would still match /users/:id here.
  });
});
