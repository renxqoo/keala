/**
 * EXT-1 / createMiddleware / validOf — typed context extension points.
 *
 * The `declare module` block below is LOAD-BEARING for the type tests: it
 * proves an augmentation aimed at the ROOT entry ("../../src/index.ts") merges
 * into the ORIGINAL `ContextExtensions` symbol declared in src/types.ts —
 * not a barrel-local shadow — and therefore flows into `Context` everywhere,
 * including modules that import Context from its deep source path and never
 * touch the barrel. Every `Expect<…>` alias below is a compiled assertion:
 * if the merge stops propagating anywhere, `tsc --noEmit` fails this file.
 *
 * Published-package note: consumers augment `declare module "keala"` — the
 * same mechanism against the package name; in-repo tests must use the source
 * specifier because dist/ (the exports target) is not built here.
 */

import { describe, expect, it } from "vitest";

import { createMiddleware, Keala } from "../../src/index.ts";
import type { Context, ContextExtensions, Next } from "../../src/index.ts";
import type { Context as DeepContext } from "../../src/core/context/context.ts";
import { validOf, validator, type StandardSchema } from "../../src/middleware/index.ts";
import type { RouteHandler } from "../../src/router/router.ts";

/** The service this suite installs as a decorated context member. */
interface EchoService {
  echo(message: string): string;
}

declare module "../../src/index.ts" {
  interface ContextExtensions {
    kealaEcho: EchoService;
  }
}

// --- compiled assertions (EXT-1): merge → Context, via BOTH import paths ---
type Expect<T extends true> = T;
type HasKealaEcho<T> = T extends { kealaEcho: EchoService } ? true : false;
/** True iff the barrel import's Context carries the merged member. */
export type BarrelMergeWorks = Expect<HasKealaEcho<Context>>;
/** True iff the deep-path import's Context carries it too (no shadowing). */
export type DeepPathMergeWorks = Expect<HasKealaEcho<DeepContext>>;
/** The augmentation target is the same symbol the barrel re-exports. */
export type AliasIsMerged = Expect<HasKealaEcho<Pick<ContextExtensions, "kealaEcho">>>;
/** RouteHandler's context sees the merge as well (it is the same Context). */
export type HandlerMergeWorks = Expect<HasKealaEcho<Parameters<RouteHandler>[0]>>;

describe("ContextExtensions declaration merging (EXT-1)", () => {
  it("decorated members are readable (and typed) on the request context", async () => {
    const service: EchoService = { echo: (message) => `echo:${message}` };
    const app = new Keala({ env: "test" });
    app.decorate("kealaEcho", service);
    let seen: string | undefined;
    app.get("/x", (c) => {
      seen = c.kealaEcho.echo("hi"); // typed read through the merge
      return c.json({ ok: true });
    });
    const response = await app.handle(new Request("http://localhost/x"));
    expect(response.status).toBe(200);
    expect(seen).toBe("echo:hi");
  });

  it("decorateLazy members are typed the same way", async () => {
    const app = new Keala({ env: "test" });
    app.decorateLazy("kealaEcho", () => ({ echo: (message: string) => `lazy:${message}` }));
    app.get("/x", (c) => c.text(c.kealaEcho.echo("ho")));
    const response = await app.handle(new Request("http://localhost/x"));
    expect(await response.text()).toBe("lazy:ho");
  });
});

describe("createMiddleware (typed middleware factory)", () => {
  it("returns the passed function unchanged — identity, zero wrapping", () => {
    const calls: number[] = [];
    const factory = createMiddleware<{ trace: (m: string) => void }>();
    const handler: (c: Context & { trace: (m: string) => void }, next: Next) => Promise<void> = (
      c,
      next,
    ) => {
      c.trace(`entered #${calls.length}`); // compiles only if C was threaded through
      return next();
    };
    expect(factory(handler)).toBe(handler);
  });

  it("no-arg form accepts a plain Context handler (C defaults to all merges)", () => {
    const plain = createMiddleware()((c, next) => {
      // c carries every globally merged member — kealaEcho included.
      c.kealaEcho.echo("plain");
      return next();
    });
    expect(typeof plain).toBe("function");
  });

  it("narrows one middleware without global merging; promised members reach downstream", async () => {
    const app = new Keala({ env: "test" });
    const marks: string[] = [];
    // `stamp` is NOT merged into ContextExtensions — only this middleware's
    // C promises it, and only this app decorates it.
    app.decorate("stamp", (m: string) => marks.push(m));
    app.use(
      createMiddleware<{ stamp: (m: string) => void }>()(async (c, next) => {
        c.stamp("before");
        await next(); // the onion contract: await, never .then — sync chains
        c.stamp("after"); // settle synchronously and next() yields undefined
      }),
    );
    app.get("/x", (c) => c.json({}));
    const response = await app.handle(new Request("http://localhost/x"));
    expect(response.status).toBe(200);
    expect(marks).toEqual(["before", "after"]);
  });
});

describe("validOf (typed validator accessor, UX-2a)", () => {
  const schema: StandardSchema = {
    "~standard": {
      version: 1,
      validate: (value) => ({
        value: { accepted: value, doubled: typeof value === "number" ? value * 2 : 0 },
      }),
    },
  };

  it("returns the parsed value, typed as T", async () => {
    const app = new Keala({ env: "test" });
    app.post("/x", validator(schema), (c) => {
      const input = validOf<{ accepted: unknown; doubled: number }>(c);
      return c.json({ doubled: input.doubled });
    });
    const response = await app.handle(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify(21),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await response.json()).toEqual({ doubled: 42 });
  });

  it("reads the same slot the c.valid getter reads", async () => {
    const app = new Keala({ env: "test" });
    let viaGetter: unknown;
    app.post("/x", validator(schema), (c) => {
      viaGetter = (c as { valid?: unknown }).valid;
      return c.json({});
    });
    await app.handle(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify(1),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(viaGetter).toEqual({ accepted: 1, doubled: 2 });
  });

  it("throws a TypeError naming the fix when no validator ran upstream", async () => {
    const app = new Keala({ env: "test" });
    let thrown: unknown;
    app.post("/x", (c) => {
      try {
        validOf(c);
      } catch (error) {
        thrown = error;
      }
      return c.json({});
    });
    await app.handle(new Request("http://localhost/x", { method: "POST", body: "{}" }));
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toContain("validator(schema)");
  });
});
