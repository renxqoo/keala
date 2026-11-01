const mode = process.argv[2];
const host = { requestIP: () => ({ address: "127.0.0.1" }) };
const wait = { value: () => {} };
const runtime = { enumerable: true, value: undefined };
const ip = { enumerable: true, configurable: true, get: undefined };
const properties = { waitUntil: wait, runtime, ip };
let busy = false;
const install =
  mode === "fresh"
    ? (request) => {
        Object.defineProperty(request, "waitUntil", wait);
        Object.defineProperty(request, "runtime", {
          enumerable: true,
          value: { name: "bun", bun: { server: host } },
        });
        Object.defineProperty(request, "ip", {
          enumerable: true,
          configurable: true,
          get() {
            return host.requestIP(request).address;
          },
        });
      }
    : mode === "batch"
      ? (request) => {
          const owner = !busy;
          const r = owner ? runtime : { enumerable: true, value: undefined };
          const p = owner ? ip : { enumerable: true, configurable: true, get: undefined };
          const all = owner ? properties : { waitUntil: wait, runtime: r, ip: p };
          busy = true;
          try {
            r.value = { name: "bun", bun: { server: host } };
            const get = () => host.requestIP(request).address;
            p.get = get;
            Object.defineProperties(request, all);
          } finally {
            r.value = undefined;
            p.get = undefined;
            if (owner) busy = false;
          }
        }
      : mode === "shared"
        ? (request) => {
            const owner = !busy;
            const r = owner ? runtime : { enumerable: true, value: undefined };
            const p = owner ? ip : { enumerable: true, configurable: true, get: undefined };
            busy = true;
            try {
              Object.defineProperty(request, "waitUntil", wait);
              r.value = { name: "bun", bun: { server: host } };
              Object.defineProperty(request, "runtime", r);
              const get = () => host.requestIP(request).address;
              p.get = get;
              Object.defineProperty(request, "ip", p);
            } finally {
              r.value = undefined;
              p.get = undefined;
              if (owner) busy = false;
            }
          }
        : () => {};
let sink = 0;
function batch(n) {
  for (let i = 0; i < n; i++) {
    const request = new Request("http://example.test/user");
    install(request);
    sink += request.method.length + request.url.length + new Response("ok").status;
  }
}
batch(10000);
const rounds = [];
for (let r = 0; r < 5; r++) {
  const b = process.cpuUsage();
  batch(100000);
  const c = process.cpuUsage(b);
  rounds.push((c.user + c.system) / 100000);
}
console.log(JSON.stringify({ mode, microseconds: rounds, sink }));
