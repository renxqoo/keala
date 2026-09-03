import { describe, expect, it } from "vitest";
import { createPlannedResponse, responseFactsOf } from "../src/core/response-plan.ts";

describe("R4.5 validated header plans", () => {
  it("validates default-status headers without constructing a native body owner", () => {
    for (const init of [
      { headers: { "x-one": "1" } },
      { status: 200, headers: { "x-one": "1" } },
      { status: 200, statusText: "", headers: new Headers({ "x-one": "1" }) },
      { status: 200 },
      { statusText: "" },
    ]) {
      const response = createPlannedResponse("body", init);
      expect(response.status).toBe(200);
      expect(response.statusText).toBe("");
      expect(response.bodyUsed).toBe(false);
      expect(responseFactsOf(response)?.native).toBeUndefined();
    }
  });

  it("snapshots records, tuples and Headers before the caller can mutate them", () => {
    const record = { "X-Snapshot": "  before\t" };
    const tuples: [string, string][] = [["X-Snapshot", "  before\t"]];
    const headers = new Headers(record);
    const plans = [record, tuples, headers].map((input) =>
      createPlannedResponse("body", { headers: input }),
    );
    record["X-Snapshot"] = "after";
    tuples[0]![1] = "after";
    headers.set("x-snapshot", "after");
    for (const plan of plans) expect(plan.headers.get("x-snapshot")).toBe("before");
  });

  it("consumes a one-shot header iterable exactly once, at construction", async () => {
    let visits = 0;
    function* entries(): Generator<[string, string]> {
      visits++;
      yield ["X-Once", "yes"];
      yield ["set-cookie", "a=1"];
      yield ["set-cookie", "b=2"];
    }
    const response = createPlannedResponse("body", {
      headers: entries() as unknown as ResponseInit["headers"],
    });
    expect(visits).toBe(1);
    const clone = response.clone();
    expect(response.headers.get("x-once")).toBe("yes");
    expect(clone.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(await clone.text()).toBe("body");
    expect(await response.text()).toBe("body");
    expect(visits).toBe(1);
  });

  it("rejects invalid header names and values eagerly with the native error type", () => {
    for (const headers of [
      { "bad name": "x" },
      { "x-name": "bad\r\nvalue" },
      { "x-name": "bad\0value" },
      [["only-name"]],
    ]) {
      const init = { headers } as unknown as ResponseInit;
      let error: Error | undefined;
      try {
        void new Response("body", init);
      } catch (caught) {
        error = caught as Error;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect(() => createPlannedResponse("body", init)).toThrow(error!.constructor);
    }
  });

  it("preserves runtime-inferred types, explicit empty types and byte snapshots", async () => {
    for (const body of ["你好", new Uint8Array([1, 2, 3])]) {
      const inputs: Record<string, string>[] = [{ "x-one": "1" }, { "content-type": "" }];
      for (const headers of inputs) {
        const native = new Response(body, { headers });
        const plan = createPlannedResponse(body, { headers });
        expect([...plan.headers]).toEqual([...native.headers]);
        expect(await plan.arrayBuffer()).toEqual(await native.arrayBuffer());
      }
    }
    const body = Buffer.from([1, 2, 3]);
    const plan = createPlannedResponse(body, { headers: { "x-snapshot": "yes" } });
    body.fill(9);
    expect([...new Uint8Array(await plan.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("uses exactly one public Headers owner after observation and clone", async () => {
    const response = createPlannedResponse("body", { headers: { "x-one": "1" } }, "text/plain");
    const held = response.headers;
    held.delete("content-type");
    const clone = response.clone();
    expect(clone.headers.get("content-type")).toBeNull();
    held.set("content-type", "application/custom");
    held.set("x-one", "later");
    void response.body;
    expect(response.headers).toBe(held);
    expect(responseFactsOf(response)?.native?.headers).toBe(held);
    expect(responseFactsOf(response)?.headerSnapshot).toBeUndefined();
    expect(clone.headers.get("x-one")).toBe("1");
    expect((await response.blob()).type).toBe("application/custom");
    expect(await clone.text()).toBe("body");
    expect(responseFactsOf(response)).toBeUndefined();
  });

  it("keeps locked, cancelled and consumed header plans off the direct writer", async () => {
    const plan = createPlannedResponse("body", { headers: { "x-one": "1" } });
    const reader = plan.body!.getReader();
    expect(responseFactsOf(plan)).toBeUndefined();
    expect(() => plan.clone()).toThrow(TypeError);
    reader.releaseLock();
    // Bun marks a native string body used on getReader; Node waits for read.
    const native = new Response("body");
    const nativeReader = native.body!.getReader();
    nativeReader.releaseLock();
    expect(plan.bodyUsed).toBe(native.bodyUsed);
    expect(responseFactsOf(plan) === undefined).toBe(native.bodyUsed);
    await plan.body!.cancel();
    expect(responseFactsOf(plan)).toBeUndefined();
    expect(() => plan.clone()).toThrow(TypeError);
  });
});
