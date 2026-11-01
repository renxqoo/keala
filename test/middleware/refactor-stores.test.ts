import { describe, expect, it } from "vitest";
import { Keala } from "../../src/core/app.ts";
import { rateLimit, type RateLimitStore } from "../../src/middleware/rate-limit.ts";

describe("asynchronous atomic rate-limit stores", () => {
  it("awaits the atomic post-increment count before admitting a request", async () => {
    let count = 0;
    const store = {
      async hit() {
        const recorded = ++count;
        await Promise.resolve();
        return { count: recorded, resetAt: Date.now() + 60_000 };
      },
      async get() {
        return undefined;
      },
    };
    const app = new Keala({ env: "test" });
    app.use(rateLimit({ limit: 1, key: () => "shared", store: store satisfies RateLimitStore }));
    app.get("/", (c) => c.text("ok"));
    const responses = await Promise.all([
      app.handle(new Request("http://local/")),
      app.handle(new Request("http://local/")),
    ]);
    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 429]);
  });
});
