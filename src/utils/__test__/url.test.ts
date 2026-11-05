import { expect, it } from "vitest";
import { getPath, getSearch } from "../url.ts";

it.each([
  ["http://example.test?next=/private", "/", "?next=/private"],
  ["http://example.test#fragment/private?ignored=1", "/", ""],
  ["https://example.test:8443/public?next=/private#ignored", "/public", "?next=/private"],
  ["http://example.test/a%2Fb?next=/private", "/a%2Fb", "?next=/private"],
])("does not treat query or fragment slashes as the path of %s", (url, path, search) => {
  expect(getPath(url)).toBe(path);
  expect(getSearch(url)).toBe(search);
});
