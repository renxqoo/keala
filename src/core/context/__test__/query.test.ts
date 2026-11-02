import { expect, it } from "vitest";
import { Keala } from "../../../index.ts";

it.each([
  ["", "missing", undefined, []],
  ["?", "missing", undefined, []],
  ["&&&&", "a", undefined, []],
  ["a", "a", "", [""]],
  ["a=", "a", "", [""]],
  ["=b", "", undefined, []],
  ["a=1&a=2&a=3", "a", "1", ["1", "2", "3"]],
  ["a=1&b&a=2", "b", "", [""]],
  ["a=1&&b=2", "b", "2", ["2"]],
  ["a[b]=c", "a[b]", "c", ["c"]],
  ["%2F=%3F", "/", "?", ["?"]],
  ["a+b=c+d", "a b", "c d", ["c d"]],
  ["a%2Bb=c%2Bd", "a+b", "c+d", ["c+d"]],
  ["%zz=%zz", "%zz", "%zz", ["%zz"]],
  ["a%00b=1", "a\0b", "1", ["1"]],
  ["bad=%E0%A4%A", "bad", "%E0%A4%A", ["%E0%A4%A"]],
  ["value=%41+%ZZ%42", "value", "A %ZZB", ["A %ZZB"]],
  ["x=%C0%AF..%C0%AFetc", "x", "%C0%AF..%C0%AFetc", ["%C0%AF..%C0%AFetc"]],
] as const)("query readers decode %s for key %s", async (search, key, first, all) => {
  const app = new Keala({ env: "test" });
  app.get("/", (c) => c.json({ first: c.query(key), all: c.queries(key) }));
  const response = await app.handle(new Request(`http://localhost/?${search}`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...(first === undefined ? {} : { first }), all });
});

it("reads prototype-looking names as strings without creating a query object", async () => {
  const app = new Keala({ env: "test" });
  app.get("/", (c) =>
    c.json([
      c.query("__proto__"),
      c.query("constructor"),
      c.query("prototype"),
      c.query("constructor.name"),
    ]),
  );
  const response = await app.handle(
    new Request("http://localhost/?__proto__=1&constructor=2&prototype=3&constructor.name=x"),
  );
  expect(await response.json()).toEqual(["1", "2", "3", "x"]);
  expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
});

it("keeps repeated keys-only query scans bounded on hostile inputs", async () => {
  const app = new Keala({ env: "test" });
  app.get("/", (c) => {
    const start = performance.now();
    const values = c.queries("a");
    const missing = c.query("missing");
    const last = c.query("z");
    expect(performance.now() - start).toBeLessThan(100);
    return c.json({ count: values.length, first: values[0], last, missing });
  });
  const response = await app.handle(new Request(`http://localhost/?${"a&".repeat(120_000)}z=1`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ count: 120_000, first: "", last: "1" });
});

it("finds keys beyond 25,000 unrelated parameters without parsing the entire map", async () => {
  const search = Array.from({ length: 25_000 }, (_, i) => `k${i}=1`).join("&");
  const app = new Keala({ env: "test" });
  app.get("/", (c) => c.json({ first: c.query("k0"), last: c.query("k24999") }));
  const response = await app.handle(new Request(`http://localhost/?${search}`));
  expect(await response.json()).toEqual({ first: "1", last: "1" });
});

it("decodes deeply nested percent signs without recursive decoding", async () => {
  const app = new Keala({ env: "test" });
  app.get("/", (c) => c.text(c.query("k") ?? "missing"));
  const response = await app.handle(new Request(`http://localhost/?k=${"%25".repeat(2000)}`));
  expect(await response.text()).toBe("%".repeat(2000));
});
