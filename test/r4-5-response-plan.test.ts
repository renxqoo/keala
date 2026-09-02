import { describe, expect, it } from "vitest";

import {
  createPlannedResponse,
  inheritResponseFacts,
  responseFactsOf,
} from "../src/core/response-plan.ts";

describe("R4.5 scoped planned Response contract", () => {
  it("preserves the public Response surface without replacing the global constructor", async () => {
    const response = createPlannedResponse(
      '{"ok":true}',
      { status: 201, statusText: "Created" },
      "application/json",
    );

    expect(response).toBeInstanceOf(Response);
    expect(Object.prototype.toString.call(response)).toBe("[object Response]");
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.ok).toBe(true);
    expect(response.redirected).toBe(false);
    expect(response.type).toBe("default");
    expect(response.url).toBe("");
    expect(response.bodyUsed).toBe(false);
    expect(response.headers.get("content-type")).toBe("application/json");

    const clone = response.clone();
    expect(await clone.json()).toEqual({ ok: true });
    expect(await response.text()).toBe('{"ok":true}');
    expect(response.bodyUsed).toBe(true);
    expect(responseFactsOf(response)).toBeUndefined();
    expect(() => response.clone()).toThrow(TypeError);
  });

  it("materializes every body reader with standard results", async () => {
    const array = createPlannedResponse("hello");
    expect(new TextDecoder().decode(await array.arrayBuffer())).toBe("hello");

    const bytes = createPlannedResponse(new Uint8Array([1, 2, 3]));
    expect([...(await (bytes as Response & { bytes(): Promise<Uint8Array> }).bytes())]).toEqual([
      1, 2, 3,
    ]);

    const blob = await createPlannedResponse("blob").blob();
    expect(await blob.text()).toBe("blob");

    const form = await createPlannedResponse("a=1&b=two", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }).formData();
    expect(form.get("a")).toBe("1");
    expect(form.get("b")).toBe("two");
  });

  it("honors live header mutation and preserves direct facts across a native rebuild", () => {
    const planned = createPlannedResponse("body", {}, "text/plain; charset=utf-8");
    planned.headers.set("x-live", "yes");
    planned.headers.delete("content-type");
    const facts = responseFactsOf(planned);
    expect(facts?.headersResolved).toBe(true);
    expect(planned.headers.get("content-type")).toBeNull();

    const rebuilt = inheritResponseFacts(
      new Response("body", { headers: { "x-rebuilt": "yes" } }),
      planned,
    );
    expect(responseFactsOf(rebuilt)?.directBody).toBe("body");
    expect(responseFactsOf(rebuilt)?.planned).toBeUndefined();
    expect(rebuilt.headers.get("x-rebuilt")).toBe("yes");

    const bytes = createPlannedResponse(new Uint8Array([1, 2, 3]));
    const rebuiltBytes = inheritResponseFacts(new Response(new Uint8Array([1, 2, 3])), bytes);
    expect(responseFactsOf(rebuiltBytes)?.directBody).toEqual(new Uint8Array([1, 2, 3]));

    const foreign = new Response("foreign");
    const untouched = new Response("target");
    expect(inheritResponseFacts(untouched, foreign)).toBe(untouched);
    expect(responseFactsOf(untouched)).toBeUndefined();
  });

  it("reports a locked foreign/direct body as ineligible for direct writing", () => {
    const planned = createPlannedResponse("locked");
    const reader = planned.body?.getReader();
    expect(responseFactsOf(planned)).toBeUndefined();
    reader?.releaseLock();
  });
});
