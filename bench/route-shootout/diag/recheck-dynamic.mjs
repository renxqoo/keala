// Calm-window HTTP recheck: all deficit shapes from the 2026-09-05 Linux
// server run (statics 0.93-0.95x, wildcard 0.92x), keala vs hono (bun).
import { spawn } from "node:child_process";
import autocannon from "autocannon";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitReady = async (port) => {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/status`);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("never ready");
};
const fire = (port, path) =>
  autocannon({
    url: `http://127.0.0.1:${port}${path}`,
    connections: 200,
    duration: 6,
    pipelining: 1,
    workers: 4,
    warmup: { connections: 200, duration: 2 },
  });
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const procs = [
  { name: "keala", cmd: ["bun", "bench/route-shootout/servers/keala-bun.ts"], port: 4312 },
  { name: "hono", cmd: ["bun", "bench/route-shootout/servers/hono-bun.ts"], port: 4314 },
];
const children = procs.map((p) =>
  spawn(p.cmd[0], [...p.cmd.slice(1), String(p.port)], { stdio: "ignore" }),
);
try {
  for (const p of procs) await waitReady(p.port);
  for (const [label, path] of [
    ["static /user (control)", "/user"],
    ["same-radix /user/comments", "/user/comments"],
    ["long static 6-seg", "/very/deeply/nested/route/hello/there"],
    ["wildcard /static/*", "/static/index.html"],
    ["mixed /event/:id/comments", "/event/abcd1234/comments"],
    ["4-seg /user/lookup/username/:username", "/user/lookup/username/hey"],
  ]) {
    const rps = { keala: [], hono: [] };
    for (let round = 0; round < 4; round++) {
      const order = round % 2 === 0 ? procs : [...procs].reverse();
      for (const p of order) {
        const res = await fire(p.port, path);
        rps[p.name].push(res.requests.average);
        process.stdout.write(p.name[0]);
      }
    }
    const k = median(rps.keala),
      h = median(rps.hono);
    const fmt = (v) => v.map((x) => Math.round(x / 1000) + "k").join(",");
    console.log(
      `\n${label}: keala ${Math.round(k).toLocaleString()} [${fmt(rps.keala)}] hono ${Math.round(h).toLocaleString()} [${fmt(rps.hono)}] ratio ${(k / h).toFixed(2)}x`,
    );
  }
} finally {
  for (const c of children) c.kill("SIGKILL");
}
