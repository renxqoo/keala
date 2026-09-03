/**
 * Registration/parse guards extracted from agent-r5-runtime-locks for its
 * 500-line budget: the mergeMountedWs missing-handlers refusal and the full
 * parseListenArgs option-bag coverage.
 */

import { describe, expect, it } from "vitest";

import { mergeMountedWs } from "../src/core/registration.ts";
import { parseListenArgs } from "../src/core/listen.ts";
import { createRouterState, registerDef } from "../src/router/router.ts";
import { EMPTY_MIDDLEWARE_STACK } from "../src/core/middleware-stack.ts";

describe("listen and mount guards", () => {
  it("mergeMountedWs refuses a def whose ws handlers are missing", () => {
    const state = createRouterState();
    const def = registerDef(state, "GET", "/ws", [() => undefined]);
    def.wsKey = "/old-key";
    // A ws def whose key is absent from the handlers map would silently
    // register an upgrade that can never find its socket handlers.
    expect(() =>
      mergeMountedWs(new Map(), state, "/prefix", [], def, EMPTY_MIDDLEWARE_STACK, new Map()),
    ).toThrow(/no ws handlers found/);
  });

  it("parseListenArgs covers the full option bag", () => {
    const full = parseListenArgs([
      {
        port: 1,
        reusePort: true,
        maxRequestBodySize: 4096,
        development: true,
        onServeError: () => undefined,
      },
    ]);
    expect(full.listen.port).toBe(1);
    expect(full.listen.reusePort).toBe(true);
    expect(full.listen.maxRequestBodySize).toBe(4096);
    expect(full.listen.development).toBe(true);
    expect(typeof full.listen.onServeError).toBe("function");
  });
});
