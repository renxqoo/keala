/**
 * ROUND 6 audit — property invariants INV-4..6 (routing determinism, prototype pollution, pooling isolation). Split of the original r6 file for the
 * 500-line repo budget; harness and ledger identical.
 */

import { describe, expect, it } from "vitest";
import {
  COOKIE_NAMES,
  PRINTABLE,
  TOKEN,
  quiet,
  randCookieHeader,
  randPath,
  randQueryString,
  randString,
} from "./agent-r6-prop-rig.mts";
import { CONTEXT_SLOT_KEYS } from "../src/core/context/context.ts";
import { runProp } from "./agent-r6-prop-ops.mts";
import { Keala } from "../src/index.ts";

describe("INV-4 routing determinism", () => {
  it("dynamic patterns (optional / custom regex / wildcard / trailing slash) match deterministically", async () => {
    await runProp("dynamic-determinism", 120, async (rng) => {
      const app = new Keala({ ...quiet });
      app.get("/opt/:x?/tail", (c) => c.text(`opt:${c.params?.["x"] ?? "-"}`));
      app.get("/num/:n(\\d+)", (c) => c.text(`num:${c.params?.["n"]}`));
      app.get("/w/*", (c) => c.text(`w:${c.params?.["wildcard"]}`));
      app.get("/plain", (c) => c.text("plain"));
      const targets = [
        "/opt/tail",
        "/opt/a/tail",
        "/num/123",
        "/num/abc",
        "/w/",
        "/w/a/b/c",
        "/plain",
        "/plain/",
        "/opt/tail/",
        "/num/123/",
        "/w",
      ];
      const expected = new Map<string, string>();
      for (const t of targets) {
        const r = await app.handle(new Request(`http://localhost${t}`));
        expected.set(t, `${r.status}:${await r.text()}`);
      }
      for (let rep = 0; rep < 10; rep++) {
        for (const t of rng.bool(0.5) ? targets : [...targets].reverse()) {
          const r = await app.handle(new Request(`http://localhost${t}`));
          const actual = `${r.status}:${await r.text()}`;
          const want = expected.get(t) as string;
          if (actual !== want) throw new Error(`${t} => ${actual}, want ${want}`);
        }
      }
    });
  }, 20_000);

  it("100 consecutive matches are identical; encoding variants never land on a different route", async () => {
    await runProp("routing-determinism", 60, async (rng, _seed, ctx) => {
      const app = new Keala({ ...quiet });
      const registrations: Array<[string, string, string]> = [
        ["GET", "/a/b", "M1"],
        ["GET", "/a/:x", "M2"],
        ["GET", "/users/:id/posts/:pid", "M3"],
        ["GET", "/files/*", "M4"],
      ];
      const shuffled = [...registrations];
      // random extra duplicate registrations
      for (let i = 0; i < rng.range(0, 3); i++) {
        const r = shuffled[rng.int(shuffled.length)] as [string, string, string];
        shuffled.push([r[0], r[1], `dup-${i}`]);
      }
      for (const [method, path, marker] of shuffled) {
        app.on(method, path, (c) => c.text(marker));
      }
      const notFoundMarker = async (): Promise<string> => {
        const r = await app.handle(new Request("http://localhost/zzz-not-registered"));
        return `${r.status}:${await r.text()}`;
      };
      const baseline404 = await notFoundMarker();

      const url = `http://localhost${randPath(rng)}`;
      const method = rng.pick(["GET", "POST", "HEAD", "OPTIONS", "PUT"] as const);
      let first: Request;
      try {
        first = new Request(url, { method });
      } catch {
        ctx.skipped++;
        return;
      }
      const r0 = await app.handle(new Request(first.url, { method }));
      const expected = `${r0.status}:${await r0.text()}`;
      for (let i = 0; i < 50; i++) {
        const r = await app.handle(new Request(first.url, { method }));
        const actual = `${r.status}:${await r.text()}`;
        if (actual !== expected) {
          throw new Error(`nondeterministic match at rep ${i}: ${actual} != ${expected}`);
        }
      }
      // Encoding variants: same resource shape must hit the same route or none
      // — never a DIFFERENT registered route.
      for (const variant of [
        "/a%2Fb",
        "/a%2fb",
        "/a/b/",
        "//a/b",
        "/a/./b",
        "/a/b/..",
        "/a%252Fb",
      ]) {
        const vr = await app.handle(new Request(`http://localhost${variant}`));
        const vres = `${vr.status}:${await vr.text()}`;
        const m1 = `${(await app.handle(new Request("http://localhost/a/b"))).status}:M1`;
        if (vres !== m1 && vres !== expected && vres !== baseline404) {
          throw new Error(
            `variant ${variant} => ${vres} (canonical=${expected}, 404=${baseline404})`,
          );
        }
      }
    });
  }, 25_000);
});
describe("INV-5 no-prototype-pollution", () => {
  const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort().join(",");
  const globalBefore = Object.getOwnPropertyNames(globalThis).sort().join(",");

  it("random query/cookie/JSON inputs leave Object.prototype and globals untouched", async () => {
    await runProp("no-proto-pollution", 250, async (rng, _seed, ctx) => {
      const app = new Keala({ ...quiet, keys: ["r6-secret"] });
      let queryHasProto = true;
      app.on("ALL", "/*", async (c) => {
        // The map is gone: targeted reads are plain string returns — a
        // __proto__ QUERY is just a key lookup, inherently pollution-free.
        void c.query(randString(rng, 4, TOKEN));
        queryHasProto = c.query("__proto__") === "__proto__";
        void c.cookies.get(rng.pick(COOKIE_NAMES));
        void c.cookies.get("__proto__");
        try {
          const parsed: unknown = JSON.parse(await c.raw.text());
          if (parsed !== null && typeof parsed === "object") {
            for (const k of Object.keys(parsed)) void (parsed as Record<string, unknown>)[k];
          }
        } catch {
          /* non-JSON bodies are fine */
        }
        return c.json({ ok: true });
      });
      const body = JSON.stringify({
        __proto__: { polluted: "yes" },
        constructor: { prototype: { polluted: "yes" } },
        [randString(rng, 6, TOKEN)]: randString(rng, 10, PRINTABLE),
      });
      let req: Request;
      try {
        req = new Request(`http://localhost/x?${randQueryString(rng)}`, {
          method: "POST",
          headers: { cookie: randCookieHeader(rng), "content-type": "application/json" },
          body,
        });
      } catch {
        ctx.skipped++;
        return;
      }
      const res = await app.handle(req);
      expect(res).toBeInstanceOf(Response);
      await res.text();
      expect(queryHasProto).toBe(false);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
      expect(Object.getOwnPropertyNames(Object.prototype).sort().join(",")).toBe(protoBefore);
      expect(Object.getOwnPropertyNames(globalThis).sort().join(",")).toBe(globalBefore);
    });
  }, 20_000);
});
describe("INV-6 pooling isolation", () => {
  it("100 sequential requests never observe a previous request's own/symbol/state/cache data", async () => {
    await runProp("pooling-isolation", 12, async (rng) => {
      const app = new Keala({ ...quiet, pooling: true });
      const SYM = Symbol("r6leak");
      let baseline: (string | symbol)[] | null = null;
      const problems: string[] = [];
      let n = 0;
      app.get("/req", (c) => {
        const id = ++n;
        const keys = Reflect.ownKeys(c);
        if (baseline === null) {
          baseline = [...keys];
        } else {
          const base = baseline as (string | symbol)[];
          // Internal slots may appear as own keys on a RECYCLED context —
          // assign-clearing restores their CONTEXT_DEFAULTS sentinels, so
          // they carry no prior-request data (the value assertions below
          // hold the leak contract). Anything else is foreign.
          const extra = keys.filter(
            (k) => !base.includes(k) && !CONTEXT_SLOT_KEYS.includes(k as string),
          );
          if (extra.length > 0) {
            problems.push(`req#${id}: foreign own keys survived: ${extra.map(String).join(",")}`);
          }
        }
        const anyC = c as unknown as Record<PropertyKey, unknown>;
        if (anyC["bodyCache"] !== undefined) problems.push(`req#${id}: bodyCache leaked`);
        if (anyC["validValue"] !== undefined) problems.push(`req#${id}: validValue leaked`);
        if (Object.keys(c.state).length !== 0) {
          problems.push(`req#${id}: state leaked: ${Object.keys(c.state).join(",")}`);
        }
        if (c.resHeader("x-leak") !== "") problems.push(`req#${id}: staged header leaked`);
        if (c.resHeader("set-cookie") !== "") problems.push(`req#${id}: cookie leaked`);
        if (c.params !== null && Object.keys(c.params).length !== 0) {
          problems.push(`req#${id}: params leaked`);
        }
        // This request's junk (must not survive the recycle).
        anyC[`junk${id}`] = `secret-${id}`;
        anyC[SYM] = `secret-${id}`;
        c.state[`s${id}`] = { secret: id };
        anyC["bodyCache"] = { secret: id };
        anyC["validValue"] = { secret: id };
        c.cookies.set("leak", `secret-${id}`);
        c.setHeader("x-leak", `secret-${id}`);
        return c.text(`req-${id}`);
      });
      app.get("/stream", (c) => {
        const id = ++n;
        const anyC = c as unknown as Record<PropertyKey, unknown>;
        anyC[`junkS${id}`] = `secret-${id}`;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`chunk-${id}-`));
              controller.enqueue(new TextEncoder().encode(`secret-${id}`));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/plain" } },
        );
      });
      for (let i = 0; i < 100; i++) {
        const useStream = rng.bool(0.25);
        const res = await app.handle(
          new Request(`http://localhost${useStream ? "/stream" : "/req"}`),
        );
        expect(res).toBeInstanceOf(Response);
        if (useStream && rng.bool(0.5)) {
          // read one chunk, then cancel — retire through the cancel path
          const reader = res.body?.getReader();
          if (reader !== undefined) {
            await reader.read();
            await reader.cancel();
          }
        } else {
          await res.text();
        }
      }
      if (problems.length > 0) throw new Error(problems.slice(0, 3).join(" | "));
    });
  }, 30_000);

  it("a late write on a context sitting in the pool never corrupts the next request", async () => {
    await runProp("pool-late-write-guard", 40, async (rng) => {
      const app = new Keala({ ...quiet, pooling: true });
      let guardFailures = 0;
      let corruptions = 0;
      app.get("/a", (c) => {
        // Fire-and-forget writes landing AFTER this request retired. Direct
        // response accessors must throw (the retired guard). Lazy facades
        // (cookies/state) create detached records on a retired context — not
        // guarded, but recycle resets those slots, so the hard invariant is
        // corruption-freedom of the follow-up request either way.
        const captured = c;
        setTimeout(
          () => {
            try {
              captured.status = 500; // direct accessor: must throw while retired
              guardFailures++;
            } catch {
              /* the documented guard */
            }
            try {
              captured.setHeader("x-late", "evil"); // direct method: must throw
              guardFailures++;
            } catch {
              /* guard */
            }
            try {
              captured.cookies.set("late", "evil"); // facade: detached-record write
            } catch {
              /* throwing is fine too */
            }
            try {
              captured.state.evil = true; // facade: detached-record write
            } catch {
              /* throwing is fine too */
            }
          },
          rng.range(5, 20),
        );
        return c.text("a");
      });
      app.get("/b", (c) => {
        if (c.resHeader("x-late") !== "" || c.resHeader("set-cookie") !== "") corruptions++;
        if (Object.keys(c.state).length !== 0) corruptions++;
        return c.text("b");
      });
      const ra = await app.handle(new Request("http://localhost/a"));
      await ra.text(); // retire A into the pool
      await new Promise((r) => setTimeout(r, 40)); // let the late writes fire
      const rb = await app.handle(new Request("http://localhost/b"));
      const body = await rb.text();
      if (body !== "b" || rb.status !== 200) corruptions++;
      if (guardFailures > 0)
        throw new Error(`${guardFailures} late writes slipped past the retired guard`);
      if (corruptions > 0) throw new Error("late writes corrupted the follow-up request");
    });
  }, 30_000);
});
