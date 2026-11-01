import { describe, expect, it, vi } from "vitest";
import {
  compileRoutes,
  type Definition,
  type Selection,
} from "../../experimental/kernel/router.ts";
import { compileRoutesRegExp } from "../../experimental/kernel/router-regexp.ts";

const definition = (method: string, path: string, label = path): Definition => ({
  method,
  path,
  endpoint: { kind: "text", handler: () => label },
});
const view = (selection: Selection) =>
  selection.kind === "route"
    ? {
        kind: selection.kind,
        endpointKind: selection.endpoint.kind,
        path: selection.path,
        handler: selection.endpoint.handler,
        params: Object.entries(selection.params),
        prototype: Object.getPrototypeOf(selection.params),
      }
    : {
        kind: selection.kind,
        path: selection.path,
        status: selection.reply.status,
        body: selection.reply.body,
        headers: selection.reply.headers,
      };
const outcome = (
  match: (method: string, path: string) => Selection,
  method: string,
  path: string,
) => {
  try {
    return view(match(method, path));
  } catch (error) {
    return { error: (error as Error).constructor.name, message: (error as Error).message };
  }
};
const assertEquivalent = (
  defs: Definition[],
  targets: string[],
  methods = ["GET", "POST", "HEAD", "OPTIONS", "PATCH"],
) => {
  const reference = compileRoutes(defs),
    candidate = compileRoutesRegExp(defs);
  for (const method of methods)
    for (const path of targets)
      expect(outcome(candidate, method, path), `${method} ${JSON.stringify(path)}`).toEqual(
        outcome(reference, method, path),
      );
};

describe("isolated compiled RegExp router candidate", () => {
  it("preserves static precedence, dead-branch backtracking and empty wildcard terminals", () => {
    const defs = [
      definition("GET", "/fixed/other"),
      definition("GET", "/:id/end"),
      definition("GET", "/x/*rest"),
      definition("GET", "/x/:id/*rest"),
      definition("GET", "/x/:id"),
      definition("GET", "/x/fixed/child"),
      definition("GET", "/literal.+(a)[b]{c}^$|d"),
      definition("GET", "/*root"),
    ];
    assertEquivalent(defs, [
      "/fixed/end",
      "/fixed/other",
      "/x",
      "/x/",
      "/x/a",
      "/x/a/",
      "/x/a/b",
      "/x/fixed",
      "/x/fixed/child",
      "/x/fixed/missing",
      "/",
      "///",
      "/literal.+(a)[b]{c}^$|d",
      "/not-literalX+(a)[b]{c}^$|d",
    ]);
    const match = compileRoutesRegExp(defs);
    expect((match("GET", "/fixed/end") as { params: unknown }).params).toEqual({ id: "fixed" });
    expect((match("GET", "/x") as { params: unknown }).params).toEqual({ rest: "" });
    expect((match("GET", "/x/a") as { params: unknown }).params).toEqual({ id: "a" });
  });

  it("retains segment encoding, Unicode, malformed escape and strict-newline boundaries", () => {
    const defs = [
      definition("GET", "/x/:__proto__"),
      definition("GET", "/files/*rest"),
      definition("GET", "/a%2Fb/:id"),
      definition("GET", "/literal%252F/:id"),
      definition("GET", "/你好/:名"),
      definition("GET", "/line/:id/end"),
    ];
    // Non-ASCII parameter names are invalid in both compilers.
    expect(() => compileRoutesRegExp(defs)).toThrow();
    defs[4] = definition("GET", "/你好/:name");
    assertEquivalent(defs, [
      "/x/a%2Fb",
      "/x/a%252Fb",
      "/x/%25",
      "/x/%ZZ",
      "/x/%E4",
      "/x/你好",
      "/x/😀",
      "/x/a\n",
      "/x/a\nextra",
      "/line/a/end\n",
      "/line/a\n/end",
      "/line/a/end\r\n",
      "/files",
      "/files/a%2Fb/c%252Fd",
      "/files/a\nb/c",
      "/a%2Fb/7",
      "/a/b/7",
      "/literal%252F/7",
      "/literal%2F/7",
      "/你好/世界",
    ]);
    expect(compileRoutesRegExp(defs)("GET", "/line/a/end\n")).toMatchObject({
      kind: "miss",
      reply: { status: 404 },
    });
  });

  it("preserves per-method static lookup and cold HEAD/ALL/Allow selection", () => {
    assertEquivalent(
      [
        definition("POST", "/users/new"),
        definition("GET", "/users/:id"),
        definition("ALL", "/any/:id"),
        definition("HEAD", "/heads/:id"),
        definition("GET", "/heads/*tail"),
      ],
      [
        "/users/new",
        "/users/alice",
        "/any/7",
        "/heads/a",
        "/heads/a/b",
        "/absent",
        "http://example.test/users/new?q=1",
      ],
      ["GET", "get", "POST", "HEAD", "OPTIONS", "PATCH", "OTHER", "ALL"],
    );
  });

  it("normalizes target paths exactly once and does not decode cold fallback targets twice", () => {
    assertEquivalent(
      [definition("GET", "/secure/:id"), definition("ALL", "/files/*tail")],
      [
        "/public/../secure/7",
        "/public/%2e%2e/secure/7",
        "/public\\..\\secure/7",
        "http://host/public/../secure/7",
        "http://host\\public\\..\\secure\\7",
        "/files/a%252Fb",
        "/files/a%252Fb?q=1",
        "bad-target",
        "/secure/a?ignored",
        "/secure/a#ignored",
      ],
    );
  });

  it("copies endpoints and owns dynamic params while sharing frozen static matches", () => {
    const defs = [definition("GET", "/fixed"), definition("GET", "/x/:__proto__")];
    const match = compileRoutesRegExp(defs),
      fixed = match("GET", "/fixed");
    expect(Object.isFrozen(fixed)).toBe(true);
    expect(match("GET", "/fixed")).toBe(fixed);
    if (fixed.kind !== "route") throw new Error("expected fixed route");
    expect(Object.isFrozen(fixed.endpoint)).toBe(true);
    expect(Object.isFrozen(fixed.params)).toBe(true);
    const left = match("GET", "/x/one"),
      right = match("GET", "/x/two");
    if (left.kind !== "route" || right.kind !== "route") throw new Error("expected dynamic routes");
    expect(Object.getPrototypeOf(left.params)).toBe(null);
    expect(left.params).not.toBe(right.params);
    expect(Object.isFrozen(left.endpoint)).toBe(true);
    expect(left.params.__proto__).toBe("one");
    expect(right.params.__proto__).toBe("two");
    Object.assign(defs[0]!.endpoint, { handler: () => "mutated" });
    expect(fixed.endpoint.handler).not.toBe(defs[0]!.endpoint.handler);
  });

  it("preserves Fetch endpoint capability without invoking handlers during lookup", () => {
    let calls = 0;
    const handler = (_request: Request) => {
      calls++;
      return new Response("fetch");
    };
    const defs: Definition[] = [
      { method: "POST", path: "/fetch/:id", endpoint: { kind: "fetch", handler } },
    ];
    assertEquivalent(defs, ["/fetch/7", "/fetch/a%252Fb", "/fetch", "/missing"]);
    const selected = compileRoutesRegExp(defs)("POST", "/fetch/7");
    expect(selected).toMatchObject({
      kind: "route",
      endpoint: { kind: "fetch", handler },
      params: { id: "7" },
    });
    expect(calls).toBe(0);
  });

  it("reuses eager registration validation and falls back above 64 dynamic routes", () => {
    for (const path of ["x", "/x/:a/:a", "/x/:a?", "/x/*/tail", "/x/:a(.*)", "/x/%ZZ"])
      expect(() => compileRoutesRegExp([definition("GET", path)])).toThrow();
    expect(() =>
      compileRoutesRegExp([definition("GET", "/x/:a"), definition("GET", "/x/:b")]),
    ).toThrow();
    const defs = Array.from({ length: 65 }, (_, i) => definition("GET", `/r${i}/:id`));
    assertEquivalent(defs, ["/r0/first", "/r32/a%252Fb", "/r64/last", "/absent"]);
  });

  it("matches oversized dynamic sources through the reference without engine-specific limits", () => {
    const prefix = "/" + "x".repeat(50000);
    assertEquivalent(
      [definition("GET", `${prefix}/:id`)],
      [`${prefix}/a%252Fb`, prefix, "/missing"],
    );
    const left = "/a" + "x".repeat(9000),
      right = "/b" + "y".repeat(9000);
    assertEquivalent(
      [definition("GET", `${left}/:id`), definition("POST", `${right}/*rest`)],
      [`${left}/one`, `${right}/a/b`, right, "/missing"],
    );
  });

  it.each([SyntaxError, RangeError])(
    "permanently falls back after lazy %s compilation failure",
    (Failure) => {
      const marker = "__kernel_lazy_compile__";
      const match = compileRoutesRegExp([definition("GET", `/${marker}/:id`)]);
      const nativeExec = RegExp.prototype.exec;
      let calls = 0;
      const mocked = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
        this: RegExp,
        input: string,
      ) {
        if (this.source.includes(marker)) {
          calls++;
          throw new Failure("lazy compile failed");
        }
        return nativeExec.call(this, input);
      });
      try {
        expect(match("GET", `/${marker}/one`)).toMatchObject({
          kind: "route",
          params: { id: "one" },
        });
        expect(match("GET", `/${marker}/a%252Fb`)).toMatchObject({
          kind: "route",
          params: { id: "a%2Fb" },
        });
        expect(calls).toBe(1);
        expect(() => match("GET", `/${marker}/%ZZ`)).toThrow(URIError);
      } finally {
        mocked.mockRestore();
      }
    },
  );

  it("does not swallow URIError or disable the table for unrelated exec errors", () => {
    const marker = "__kernel_uri_error__";
    const match = compileRoutesRegExp([definition("GET", `/${marker}/:id`)]);
    const nativeExec = RegExp.prototype.exec;
    let calls = 0;
    const mocked = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
      this: RegExp,
      input: string,
    ) {
      if (this.source.includes(marker)) {
        calls++;
        throw new URIError("preserve URIError");
      }
      return nativeExec.call(this, input);
    });
    try {
      expect(() => match("GET", `/${marker}/one`)).toThrow(URIError);
      expect(() => match("GET", `/${marker}/two`)).toThrow(URIError);
      expect(calls).toBe(2);
    } finally {
      mocked.mockRestore();
    }
  });

  it("differentially checks 48,000 seeded legal small-table request selections", () => {
    let state = 0x5eeda11;
    const random = (limit: number) => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % limit;
    };
    const pick = <T>(values: readonly T[]): T => values[random(values.length)]!;
    const words = ["a", "b", "fixed", "你好", "x.y", "a%2Fb", "%252F", "%25", "line\n"];
    const values = [
      "a",
      "b",
      "fixed",
      "你好",
      "😀",
      "a%2Fb",
      "a%252Fb",
      "%25",
      "line\n",
      "",
      "%ZZ",
    ];
    let checked = 0,
      legal = 0,
      accepted = 0;
    while (accepted < 400) {
      const defs: Definition[] = [];
      for (let i = 0, count = 1 + random(12); i < count; i++) {
        const parts: string[] = [];
        for (let depth = 0, length = 1 + random(4); depth < length; depth++) {
          const kind = random(5);
          if (kind === 0) {
            parts.push(`*w${depth}`);
            break;
          }
          parts.push(kind <= 2 ? `:p${depth}` : pick(words));
        }
        defs.push(
          definition(pick(["GET", "POST", "HEAD", "ALL"]), "/" + parts.join("/"), String(i)),
        );
      }
      let reference: ReturnType<typeof compileRoutes>;
      try {
        reference = compileRoutes(defs);
      } catch {
        continue;
      }
      const candidate = compileRoutesRegExp(defs);
      accepted++;
      for (let request = 0; request < 120; request++) {
        const route = pick(defs),
          parts = route.path.slice(1).split("/");
        const target: string[] = [];
        for (const part of parts) {
          if (part.startsWith(":")) target.push(pick(values));
          else if (part.startsWith("*")) {
            for (let i = 0, count = random(4); i < count; i++) target.push(pick(values));
          } else target.push(part);
        }
        if (random(3) === 0) target[random(target.length || 1)] = pick(words);
        let url = "/" + target.join("/");
        if (random(5) === 0) url += "/";
        if (random(9) === 0) url += "\n";
        if (random(7) === 0) url += "?q=1";
        if (random(11) === 0) url = "http://example.test" + url;
        const method = pick(["GET", "POST", "HEAD", "OPTIONS", "PATCH", "ALL"]);
        const actual = outcome(candidate, method, url),
          expected = outcome(reference, method, url);
        if (!("error" in expected)) legal++;
        if (
          JSON.stringify(actual) !== JSON.stringify(expected) ||
          ("handler" in actual && "handler" in expected && actual.handler !== expected.handler)
        )
          expect(
            actual,
            JSON.stringify({
              defs: defs.map(({ method: verb, path }) => [verb, path]),
              method,
              url,
            }),
          ).toEqual(expected);
        checked++;
      }
    }
    expect(checked).toBe(48000);
    expect(legal).toBeGreaterThanOrEqual(30000);
  });
});
