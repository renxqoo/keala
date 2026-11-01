import assert from "node:assert/strict";
const { Keala } = await import(process.argv[2]);
const app = new Keala({ env: "test" });
let dispatch;
const original = Bun.serve;
Bun.serve = (options) => {
  dispatch = options.fetch;
  return original(options);
};
app.get("/", (c) => c.text(c.ip));
let server;
try {
  server = app.listen({ port: 0, hostname: "127.0.0.1" });
} finally {
  Bun.serve = original;
}
const inner = new Request("http://example.test/");
let nested;
let outer;
outer = new Proxy(new Request("http://example.test/"), {
  get(t, p) {
    return Reflect.get(t, p, t);
  },
  defineProperty(t, p, d) {
    if (p === "runtime") nested = dispatch(inner, innerHost);
    return Reflect.defineProperty(t, p, d);
  },
});
const outerHost = {
  requestIP: (r) => {
    assert.equal(r, outer);
    return { address: "outer" };
  },
};
const innerHost = {
  requestIP: (r) => {
    assert.equal(r, inner);
    return { address: "inner" };
  },
};
try {
  assert.equal(await (await dispatch(outer, outerHost)).text(), "outer");
  assert.equal(await (await nested).text(), "inner");
  assert.deepEqual(Reflect.ownKeys(outer), ["waitUntil", "runtime", "ip"]);
  assert.notEqual(outer.runtime, inner.runtime);
  assert.notEqual(outer.runtime.bun, inner.runtime.bun);
  assert.deepEqual(Object.getOwnPropertyDescriptor(outer, "runtime"), {
    value: outer.runtime,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  const getter = Object.getOwnPropertyDescriptor(outer, "ip").get;
  assert.equal(getter.name, "get");
  assert.equal(getter.call(inner), "outer");
  assert.throws(() => Reflect.construct(getter, []), TypeError);
  const fault = new Error("metadata fault");
  const rejected = new Proxy(new Request("http://example.test/"), {
    defineProperty(t, p, d) {
      if (p === "runtime") throw fault;
      return Reflect.defineProperty(t, p, d);
    },
  });
  assert.throws(
    () => dispatch(rejected, outerHost),
    (e) => e === fault,
  );
  const after = new Request("http://example.test/");
  const afterHost = {
    requestIP: (r) => {
      assert.equal(r, after);
      return { address: "after" };
    },
  };
  assert.equal(await (await dispatch(after, afterHost)).text(), "after");
  assert.equal(after.runtime.bun.server, afterHost);
  console.log(JSON.stringify({ source: process.argv[2], metadataContract: "passed" }));
} finally {
  await app.close({ drain: 100 });
  server.stop(true);
}
