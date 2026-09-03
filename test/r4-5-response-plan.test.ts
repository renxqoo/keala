import { describe, expect, it } from "vitest";

import {
  createPlannedResponse,
  inheritResponseFacts,
  responseFactsOf,
} from "../src/core/response-plan.ts";

describe("R4.5 scoped planned Response contract", () => {
  it("keeps default metadata lazy without storing duplicate status/header state", () => {
    const response = createPlannedResponse("body");
    expect(response.status).toBe(200);
    expect(response.statusText).toBe("");
    expect(response.bodyUsed).toBe(false);
    expect(response.ok).toBe(true);
    expect(responseFactsOf(response)?.native).toBeUndefined();
    expect(Object.keys(response).toSorted()).toEqual(["directBody", "implicitContentType"]);
  });
  it("B45-14: clone rejects a locked or cancelled body", async () => {
    const response = createPlannedResponse("body");
    const reader = response.body!.getReader();
    expect(() => response.clone()).toThrow(TypeError);
    reader.releaseLock();
    await response.body!.cancel();
    expect(() => response.clone()).toThrow(TypeError);
  });

  it("B45-14: clone snapshots headers and does not resurrect deleted content-type", async () => {
    const response = createPlannedResponse("body", {}, "application/json");
    const headers = response.headers;
    headers.set("x-copy", "before");
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    headers.delete("content-type");
    const clone = response.clone();
    headers.set("x-copy", "after");
    expect(clone.headers.get("x-copy")).toBe("before");
    expect(clone.headers.get("content-type")).toBeNull();
    expect(clone.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    clone.headers.set("x-copy", "clone");
    expect(headers.get("x-copy")).toBe("after");
    expect(response.headers).toBe(headers);
    expect(await clone.text()).toBe("body");
    expect(await response.text()).toBe("body");
  });

  it("B45-14: materialized body readers observe live response headers", async () => {
    const response = createPlannedResponse("body");
    const headers = response.headers;
    void response.body;
    headers.set("content-type", "application/custom");
    expect((await response.blob()).type).toBe("application/custom");
    expect(response.headers).toBe(headers);
  });

  it("B45-17: non-default constructor options validate eagerly and snapshot headers", () => {
    expect(() => createPlannedResponse("body", { status: 700 })).toThrow(RangeError);
    expect(() => createPlannedResponse("body", { headers: { "bad name": "x" } })).toThrow(
      TypeError,
    );
    const headers = new Headers({ "x-snapshot": "before" });
    const response = createPlannedResponse("body", { headers });
    headers.set("x-snapshot", "after");
    expect(response.headers.get("x-snapshot")).toBe("before");
  });

  it("B45-17: byte plans retain a snapshot, including Buffer and offset views", async () => {
    for (const body of [
      new Uint8Array([1, 2, 3]),
      Buffer.from([1, 2, 3]),
      new Uint8Array([0, 1, 2, 3, 0]).subarray(1, 4),
    ]) {
      const response = createPlannedResponse(body);
      body.fill(9);
      expect([...(responseFactsOf(response)!.directBody as Uint8Array)]).toEqual([1, 2, 3]);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    }
  });

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
    expect(await createPlannedResponse('{"direct":true}').json()).toEqual({ direct: true });
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

  it("B45-17: init coercion follows the runtime constructor, not nullish defaults", () => {
    for (const init of [
      { status: null },
      { status: 201.9 },
      { status: 65737 },
      { statusText: null },
      { statusText: 123 },
      // Node rejects CRLF eagerly; Bun 1.4's constructor currently accepts
      // it. The scoped plan must follow its runtime's constructor semantics.
      { statusText: "bad\r\nphrase" },
    ]) {
      const options = init as unknown as ResponseInit;
      let native: Response;
      try {
        native = new Response("body", options);
      } catch (error) {
        expect(() => createPlannedResponse("body", options)).toThrow((error as Error).constructor);
        continue;
      }
      const planned = createPlannedResponse("body", options);
      expect(planned.status).toBe(native.status);
      expect(planned.statusText).toBe(native.statusText);
    }
  });

  it("honors live header mutation and preserves direct facts across a native rebuild", () => {
    const planned = createPlannedResponse("body", {}, "text/plain; charset=utf-8");
    planned.headers.set("x-live", "yes");
    planned.headers.delete("content-type");
    const facts = responseFactsOf(planned);
    expect(facts?.native?.headers).toBe(planned.headers);
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
