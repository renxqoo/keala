// RSS trajectory under sustained load: keala(bun, after the deadline-skip)
// vs hono(bun). 3 interleaved fires × 8s, sampled every 500ms.
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
const procs = [
  { name: "keala", cmd: ["bun", "bench/route-shootout/servers/keala-bun.ts"], port: 4332 },
  { name: "hono", cmd: ["bun", "bench/route-shootout/servers/hono-bun.ts"], port: 4334 },
];
const children = procs.map((p) =>
  spawn(p.cmd[0], [...p.cmd.slice(1), String(p.port)], { stdio: "ignore" }),
);
const MB = 1048576;
try {
  for (const p of procs) await waitReady(p.port);
  const idle = {};
  for (const p of procs)
    idle[p.name] = await (await fetch(`http://127.0.0.1:${p.port}/debug/memory`)).json();
  const peaks = { keala: 0, hono: 0 };
  for (let round = 0; round < 3; round++) {
    for (const p of procs) {
      const stop = { done: false };
      const sampler = (async () => {
        while (!stop.done) {
          try {
            const mu = await (await fetch(`http://127.0.0.1:${p.port}/debug/memory`)).json();
            peaks[p.name] = Math.max(peaks[p.name], mu.rss);
          } catch {}
          await sleep(400);
        }
      })();
      await autocannon({
        url: `http://127.0.0.1:${p.port}/user`,
        connections: 200,
        duration: 8,
        pipelining: 1,
        workers: 4,
        warmup: { connections: 200, duration: 2 },
      });
      stop.done = true;
      await sampler;
      process.stdout.write(p.name[0]);
    }
  }
  const steady = {};
  for (const p of procs)
    steady[p.name] = await (await fetch(`http://127.0.0.1:${p.port}/debug/memory`)).json();
  console.log(
    `\nidle:  keala ${(idle.keala.rss / MB).toFixed(1)}MB  hono ${(idle.hono.rss / MB).toFixed(1)}MB`,
  );
  console.log(
    `steady:keala ${(steady.keala.rss / MB).toFixed(1)}MB  hono ${(steady.hono.rss / MB).toFixed(1)}MB`,
  );
  console.log(
    `peak:  keala ${(peaks.keala / MB).toFixed(1)}MB  hono ${(peaks.hono / MB).toFixed(1)}MB`,
  );
} finally {
  for (const c of children) c.kill("SIGKILL");
}
