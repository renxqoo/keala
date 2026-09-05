/**
 * R4.10 audit regressions — the lifecycle/HA findings:
 *
 *  L1  a custom AdmissionStrategy that takes admit() and then refuses
 *      (returns/throws/rejects a Response) must RETURN the slot — every
 *      refusal path exits through one refuse() helper. The leak permanently
 *      removed one capacity slot and stalled close() for the whole drain
 *      window on an idle app.
 *  L2  a websocket upgraded after the drain sweep is closed at finish()
 *      (both paths) and a post-close signal hard-stops the server — the
 *      process used to outlive close() and ignore 3x SIGTERM.
 *  L3  app.onShutdown(): handlers run once, in registration order, after
 *      the drain and before close() resolves; failures contained.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/index.ts";
import type { AdmissionStrategy } from "../../src/types.ts";

const quiet = { env: "test" } as const;

/** A strategy that takes its slot and then refuses — the leak shape. */
const admitThenRefuse = (refusal: Response): AdmissionStrategy => ({
  onSaturated: (_state, _request, admit) => {
    admit();
    return refusal;
  },
});

describe("audit L1: admission refusals return the taken slot", () => {
  it("a sync admit-then-refuse strategy leaks no capacity", async () => {
    const app = new Keala({
      ...quiet,
      overload: {
        maxConcurrency: 1,
        strategy: admitThenRefuse(new Response("busy", { status: 503 })),
      },
    });
    let release: (() => void) | undefined;
    app.get(
      "/hold",
      () => new Promise<Response>((resolve) => (release = () => resolve(new Response("done")))),
    );
    const holder = app.handle(new Request("http://x/hold"));
    const refused = await app.handle(new Request("http://x/other"));
    expect(refused.status).toBe(503);
    release?.();
    await holder;
    expect(app.inFlight).toBe(0); // the leaked slot used to strand this at 1
    const fresh = await app.handle(new Request("http://x/other"));
    expect(fresh.status).toBe(404); // capacity is back, not permanently 503
    const close = await app.close({ drain: 100 });
    expect(close).toEqual({ timedOut: false, inFlight: 0 });
  });

  it("a THROWING strategy that admitted first leaks no capacity", async () => {
    const app = new Keala({
      ...quiet,
      overload: {
        maxConcurrency: 1,
        strategy: {
          onSaturated: (_state, _request, admit) => {
            admit();
            throw new Error("strategy bug");
          },
        },
      },
    });
    let release: (() => void) | undefined;
    app.get(
      "/hold",
      () => new Promise<Response>((resolve) => (release = () => resolve(new Response("done")))),
    );
    const holder = app.handle(new Request("http://x/hold"));
    const refused = await app.handle(new Request("http://x/other"));
    expect(refused.status).toBe(503); // containment, not an escaped throw
    release?.();
    await holder;
    expect(app.inFlight).toBe(0);
    await app.close({ drain: 100 });
  });

  it("an async strategy resolving a Response after admit() leaks no capacity", async () => {
    const lateRefuser: AdmissionStrategy = {
      onSaturated: (_state, _request, admit) => {
        admit();
        return new Promise((resolve) =>
          setTimeout(() => resolve(new Response("later", { status: 503 })), 10),
        );
      },
    };
    const app = new Keala({ ...quiet, overload: { maxConcurrency: 1, strategy: lateRefuser } });
    let release: (() => void) | undefined;
    app.get(
      "/hold",
      () => new Promise<Response>((resolve) => (release = () => resolve(new Response("done")))),
    );
    const holder = app.handle(new Request("http://x/hold"));
    const refused = await app.handle(new Request("http://x/other"));
    expect(refused.status).toBe(503);
    release?.();
    await holder;
    expect(app.inFlight).toBe(0);
    await app.close({ drain: 100 });
  });

  it("a late async null no longer oversubscribes capacity", async () => {
    const lateNull: AdmissionStrategy = {
      onSaturated: () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 60)),
    };
    const app = new Keala({ ...quiet, overload: { maxConcurrency: 1, strategy: lateNull } });
    let releaseHolder: (() => void) | undefined;
    let releaseTaker: (() => void) | undefined;
    const parked = (key: "/hold" | "/probe") =>
      new Promise<Response>((resolve) => {
        if (key === "/hold") releaseHolder = () => resolve(new Response("done"));
        else releaseTaker = () => resolve(new Response("taken"));
      });
    app.get("/hold", () => parked("/hold"));
    app.get("/probe", () => parked("/probe"));
    const holder = app.handle(new Request("http://x/hold"));
    const late = app.handle(new Request("http://x/probe")); // strategy pends 60ms
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseHolder?.(); // capacity frees…
    await holder;
    // …and a fresh request TAKES it, parking: inFlight is back at the
    // ceiling when the strategy's late null lands.
    const taker = app.handle(new Request("http://x/probe"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(app.inFlight).toBe(1);
    const settled = await late;
    expect(settled.status).toBe(503); // refused, not pushed over the ceiling
    expect(app.inFlight).toBe(1);
    releaseTaker?.();
    expect(await taker.then((r) => r.status)).toBe(200);
    await app.close({ drain: 100 });
  });
});

describe("audit L3: app.onShutdown()", () => {
  it("handlers run once, in registration order, before close resolves; failures contained", async () => {
    const app = new Keala(quiet);
    const order: string[] = [];
    app.onShutdown(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push("first");
    });
    app.onShutdown(() => {
      throw new Error("boom");
    });
    app.onShutdown(() => {
      order.push("third");
    });
    app.get("/", (c) => c.text("ok"));
    const status = await app.close({ drain: 100 });
    expect(status).toEqual({ timedOut: false, inFlight: 0 });
    expect(order).toEqual(["first", "third"]);
    await app.close();
    expect(order).toEqual(["first", "third"]); // exactly once
  });

  it("rejects non-functions", () => {
    const app = new Keala(quiet);
    expect(() => app.onShutdown("nope" as unknown as () => void)).toThrow(TypeError);
  });
});
