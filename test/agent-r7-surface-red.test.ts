/**
 * Round-7 public-surface audit — CONFIRMED RED tests only.
 *
 * Scope: exported HTTP helpers, app decoration/events, MIME parsing and
 * standalone core contracts. No implementation changes live in this file.
 */

import { describe, expect, it } from "vitest";

import { Eleu, createError, normalizeError } from "../src/index.ts";
import { createEmitter } from "../src/core/emitter.ts";
import { charsetFromContentType, expandContentType } from "../src/utils/mime.ts";

const quiet = { env: "test" } as const;
const request = (path = "/"): Request => new Request(`http://localhost:3000${path}`);

describe("R7-SURFACE-1 [HIGH] decorate preserves ordinary service objects", () => {
  it("does not reinterpret every object with a get() method as a property descriptor", async () => {
    const app = new Eleu(quiet);
    const repository = {
      get(key: string) {
        return `record:${key}`;
      },
    };
    app.decorate("repository", repository);

    let observed: unknown;
    app.get("/", (c) => {
      observed = (c as unknown as { repository: unknown }).repository;
      c.body = "ok";
    });
    const response = await app.handle(request());

    // Public contract: decorate(key, value) installs VALUE. Expected: the
    // repository object itself. Actual: the `{ get }` shape is treated as an
    // accessor descriptor, so repository.get runs with the Context as `this`
    // and no key; the decorated value becomes "record:undefined".
    // Root cause: src/core/context/decorate.ts:38-49.
    expect(response.status).toBe(200);
    expect(observed).toBe(repository);
    expect((observed as typeof repository).get("user-1")).toBe("record:user-1");
  });
});

describe("R7-SURFACE-2 [MEDIUM] non-Error throwables are always normalizable", () => {
  it.each([
    ["bigint", 1n],
    [
      "circular object",
      (() => {
        const value: { self?: unknown } = {};
        value.self = value;
        return value;
      })(),
    ],
  ])("normalizes a %s without throwing from the error path", (_label, thrown) => {
    // Expected: normalizeError fulfills its documented total-function
    // contract and returns an Error whose cause is the original throwable.
    // Actual: JSON.stringify throws for BigInt and circular structures.
    // Root cause: src/http/errors.ts:147-150.
    const normalized = normalizeError(thrown);
    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.cause).toBe(thrown);
  });

  it("delivers a BigInt throwable to the public app error listener", async () => {
    const app = new Eleu(quiet);
    let heard: Error | undefined;
    app.onError((error) => {
      heard = error;
    });
    app.get("/", () => {
      throw 1n;
    });
    const response = await app.handle(request());

    // Actual response still falls back to the static 500, but normalization
    // fails before app.onerror(), so the documented listener is skipped.
    expect(response.status).toBe(500);
    expect(heard).toBeInstanceOf(Error);
    expect(heard?.cause).toBe(1n);
  });
});

describe("R7-SURFACE-3 [MEDIUM] HttpError status aliases stay coherent", () => {
  it("does not let arbitrary props overwrite statusCode independently", () => {
    // statusCode is documented as an alias of status. Expected: both remain
    // 404, as in http-errors. Actual: the generic props-copy loop excludes
    // `status` but not `statusCode`, producing an internally inconsistent
    // public HttpError.
    // Root cause: src/http/errors.ts:121-132.
    const error = createError(404, { statusCode: 503 });
    expect(error.status).toBe(404);
    expect(error.statusCode).toBe(error.status);
  });
});

describe("R7-SURFACE-4 [MEDIUM] EventEmitter duplicate removal follows Node order", () => {
  it("off(original) removes the most recently registered matching listener", () => {
    const emitter = createEmitter();
    let calls = 0;
    const listener = () => {
      calls += 1;
    };
    emitter.on("tick", listener);
    emitter.once("tick", listener);
    emitter.off("tick", listener);
    emitter.emit("tick");
    emitter.emit("tick");

    // Node removeListener semantics remove one instance, choosing the most
    // recently added. Expected: the persistent `on` remains and runs twice.
    // Actual: findIndex removes the oldest `on`, leaving `once` (one call).
    // Root cause: src/core/emitter.ts:42-49.
    expect(calls).toBe(2);
  });
});

describe("R7-SURFACE-5 [MEDIUM] onError validates listeners at subscription time", () => {
  it("rejects a non-function instead of poisoning a later error emission", () => {
    const app = new Eleu(quiet);

    // Every other registration API validates callable inputs eagerly.
    // Expected: setup-time TypeError. Actual: emitter.add stores null and a
    // later error path fails while trying to invoke it.
    // Root cause: src/core/app.ts:479-481 + src/core/emitter.ts:16-19.
    expect(() => app.onError(null as never)).toThrow(TypeError);
  });
});

describe("R7-SURFACE-6 [MEDIUM] Content-Type quoted-pairs do not break parameter parsing", () => {
  it("ignores a semicolon after an escaped quote inside another parameter", () => {
    const contentType = 'text/plain; note="a\\\";charset=decoy"; charset=utf-8';

    // RFC quoted-string permits quoted-pair (`\"`). Expected: the semicolon
    // remains inside note and the real charset after its closing quote wins.
    // Actual: every quote toggles state, including escaped quotes, so the
    // decoy is split out and returned as the charset.
    // Root cause: src/utils/mime.ts:170-181.
    expect(charsetFromContentType(contentType)).toBe("utf-8");
  });
});

describe("R7-SURFACE-7 [LOW] Content-Type extension expansion is case-insensitive", () => {
  it.each(["HTML", ".HTML", "Json", "TXT"])("keeps the default charset for %s", (value) => {
    // MIME extensions are case-insensitive. Expected: the same result as the
    // lowercase shorthand, including its default UTF-8 charset. Actual: the
    // direct map misses and the extension fallback returns a bare media type.
    // Root cause: src/utils/mime.ts:126-134.
    expect(expandContentType(value)).toBe(expandContentType(value.toLowerCase()));
  });
});
