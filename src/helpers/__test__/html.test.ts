import { expect, it } from "vitest";
import { escapeHtml } from "../../index.ts";

it("escapes HTML entities through the public helper", () => {
  expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

it.each(["é中\0\t ", "plain text 123"])(
  "preserves characters outside HTML entities: %j",
  (input) => {
    expect(escapeHtml(input)).toBe(input);
  },
);
