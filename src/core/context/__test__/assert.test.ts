import { expect, it } from "vitest";
import { baseContextProto, createContext, Keala } from "../../../index.ts";

function context() {
  const app = new Keala({ env: "test" });
  return createContext(app, baseContextProto, new Request("http://localhost/"), undefined);
}

it.each([100, 199, 200, 299, 300, 302, 399])(
  "failed assertions reject status %s instead of silently creating a 500 error",
  (status) => {
    const c = context();
    expect(() => c.assert(false, status)).toThrow(TypeError);
  },
);

it.each([400, 599])("failed assertions preserve error status %s and properties", (status) => {
  const c = context();
  expect(() =>
    c.assert(false, status, "access refused", {
      code: "access_refused",
      headers: { "x-reason": "blocked" },
    }),
  ).toThrowError(
    expect.objectContaining({
      status,
      message: "access refused",
      expose: status === 400,
      code: "access_refused",
      headers: { "x-reason": "blocked" },
    }),
  );
});

it("successful assertions do not reject unused non-error statuses", () => {
  const c = context();
  expect(() => c.assert(true, 302)).not.toThrow();
});
