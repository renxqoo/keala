/**
 * Middleware kit tests: secureHeaders, requestId, timing, logger, cors, csrf,
 * etag, compress, bodyLimit, timeout and the html escape protocol.
 */

import { describe, expect, it } from "vitest";

import { html, raw, escapeHtml } from "../../src/helpers/html.ts";

describe("html escape protocol", () => {
  it("escapes interpolations and honors raw()", () => {
    const user = '<script>alert("x")</script>';
    expect(html`<b>${user}</b>`).toBe("<b>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</b>");
    expect(html`<b>${raw(user)}</b>`).toBe(`<b>${user}</b>`);
    expect(escapeHtml("&<'\">")).toBe("&amp;&lt;&#39;&quot;&gt;");
  });

  it("flattens arrays and stringifies primitives; null vanishes", () => {
    expect(html`${[1, "a", raw("<i>")]}!`).toBe("1a<i>!");
    expect(html`x${null}${undefined}y`).toBe("xy");
  });
});
