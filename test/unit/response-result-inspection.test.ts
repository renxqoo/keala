import { expect, it } from "vitest";
import { Keala } from "../../src/core/app.ts";

it("maps inspection failures even for an original sugar response", async () => {
  const app = new Keala({ env: "test" });
  let mapped = 0;
  app.onError((_error, c) => {
    mapped++;
    return c.text("mapped", 500);
  });
  app.get("/", (c) => {
    const response = c.text("body");
    Object.defineProperty(response, "status", {
      get() {
        throw new Error("status inspection");
      },
    });
    return response;
  });
  const result = await app.handle(new Request("http://example.test/"));
  expect(result.status).toBe(500);
  expect(await result.text()).toBe("mapped");
  expect(mapped).toBe(1);
  expect(app.inFlight).toBe(0);
});

it("sanitizes empty status bodies after a sugar response is modified", async () => {
  const app = new Keala({ env: "test" });
  app.get("/", (c) => {
    const response = c.text("body");
    Object.defineProperty(response, "status", { value: 204 });
    return response;
  });
  const result = await app.handle(new Request("http://example.test/"));
  expect(result.status).toBe(204);
  expect(result.body).toBeNull();
  expect(await result.text()).toBe("");
  expect(app.inFlight).toBe(0);
});
