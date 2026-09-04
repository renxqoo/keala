/**
 * HA residual red tests (zz-red-ha-2) — guarded pooling: a floated `next()`
 * inside an ASYNC middleware is not registered as a branch (compose registers
 * only the sync-return shape), so the context is recycled while the branch is
 * still running. When the branch's late write lands inside ANOTHER request's
 * live window, it silently mutates that request's context:
 * cross-request response-body leakage under `pooling: true`.
 *
 * Deterministic in-process repro (3/3 runs); see /tmp/ha-probe-pool.mjs.
 */

import { describe, expect, it } from "vitest";
import { Keala } from "../src/core/app.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("HA-4: async-floated next() + pooling — cross-request corruption", () => {
  it("a late branch write must never become another request's response body", async () => {
    const app = new Keala({ env: "test", pooling: true });

    // /a's route middleware floats next() and settles first — the koa
    // fire-and-forget shape. The ASYNC variant is invisible to branches.ts.
    const floatMid = async (_c: unknown, next: () => Promise<void>) => {
      void next().catch(() => undefined);
      await sleep(5);
      return;
    };
    // The victim's route middleware awaits next() properly, holding its
    // chain (and its recycled context) open well past /a's late write.
    const holdMid = async (_c: unknown, next: () => Promise<void>) => {
      await next();
      await sleep(200);
    };

    app.get("/a", floatMid, async (c) => {
      await sleep(80); // late: after /a's context was retired and re-acquired
      c.body = "A-SECRET-RESPONSE";
      c.status = 200;
    });
    app.get("/victim", holdMid, async (c) => {
      c.body = "VICTIM-RESPONSE";
      c.status = 200;
    });

    const ra = app.handle(new Request("http://x/a")); // retires its ctx at ~5ms
    await sleep(15);
    const rv = app.handle(new Request("http://x/victim")); // re-acquires it, live ~215ms
    const [a, v] = await Promise.all([ra, rv]);
    const victimBody = await v.text();
    expect(await a.text()).toBe("Not Found"); // /a's own answer (float = lost)
    // FAILS today: the victim receives "A-SECRET-RESPONSE".
    expect(victimBody).toBe("VICTIM-RESPONSE");
  });

  it("the same shape must not leak per-request state across users (c.state)", async () => {
    const app = new Keala({ env: "test", pooling: true });
    const floatMid = async (_c: unknown, next: () => Promise<void>) => {
      void next().catch(() => undefined);
      await sleep(5);
      return;
    };
    const holdMid = async (_c: unknown, next: () => Promise<void>) => {
      // hold BEFORE next(): the handler (and its state read) runs late,
      // after the floated branch's write already landed on this context.
      await sleep(150);
      await next();
    };
    app.get("/login", floatMid, async (c) => {
      await sleep(60);
      c.state["user"] = "alice-secret";
      c.body = "in";
    });
    let seen: unknown = "unset";
    app.get(
      "/who",
      holdMid,
      async (c) => {
        seen = (c.state as Record<string, unknown>)["user"];
        c.body = "who";
      },
    );

    const r1 = app.handle(new Request("http://x/login"));
    await sleep(15);
    const r2 = app.handle(new Request("http://x/who"));
    await Promise.all([r1, r2]);
    expect(seen).not.toBe("alice-secret"); // FAILS today: state crosses requests
  });
});
