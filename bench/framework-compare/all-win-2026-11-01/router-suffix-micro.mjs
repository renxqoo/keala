const root = process.env.ROUTER_SRC;
const { createRouterState, registerDef, matchRoute } = await import(root + "/router/router.ts");
const { ROUTES } = await import("/Users/wrr/work/bun-koa/bench/framework-compare/scenarios.mjs");
const state = createRouterState();
for (const x of ROUTES) registerDef(state, x.method, x.route, [() => {}]);
let sink = 0;
function batch(path, n) {
  for (let i = 0; i < n; i++) {
    const m = matchRoute(state, path);
    if (!m) throw Error(path);
    sink += m.target.pattern.length + (m.names.length ? m.values[m.offset].length : 0);
  }
}
for (const x of ROUTES) batch(x.path, 10000);
const samples = [];
for (let round = 1; round <= 3; round++)
  for (const [i, x] of ROUTES.entries()) {
    const b = process.cpuUsage();
    batch(x.path, 200000);
    const c = process.cpuUsage(b);
    samples.push({ route: i + 1, round, ns: (1000 * (c.user + c.system)) / 200000 });
  }
console.log(JSON.stringify({ root, samples, sink }));
