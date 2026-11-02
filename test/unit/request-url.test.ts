import { describe, expect, it } from "vitest";
import { primeRequestUrl } from "../../src/core/request-url.ts";
import { baseContextProto, createContext } from "../../src/core/context/context.ts";
import { Keala } from "../../src/core/app.ts";

describe("routing URL prefill", () => {
  const app = new Keala({ env: "test" });
  const context = () =>
    createContext(app, baseContextProto, new Request("http://example.test/"), undefined);
  it.each([
    ["", "/", "/"],
    ["?q=1", "/", "/?q=1"],
    ["#fragment?q=1", "/", "/"],
    ["http://host?q=1", "/", "/"],
    ["http://host", "/", "/"],
    ["/a%2Fb?q=%23#fragment", "/a%2Fb", "/a%2Fb?q=%23"],
    ["http://host/path?q=1#x", "/path", "/path?q=1"],
    ["/path#fragment?q=1", "/path", "/path"],
    ["/?", "/", "/?"],
    ["?q#x", "/", "/?q"],
  ])("%s preserves path and relative URL", (url, path, view) => {
    const c = context();
    expect(primeRequestUrl(c, url)).toBe(path);
    expect(c.pathValue).toBe(path);
    expect(c.urlValue).toBe(view);
    const keys = Object.keys(c);
    expect(keys.indexOf("pathValue")).toBeLessThan(keys.indexOf("urlValue"));
  });
});
