import { spawn } from "node:child_process";
import autocannon from "autocannon";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(
  "bun",
  [
    "--heap-prof",
    "--heap-prof-dir",
    "bench/route-shootout/diag/heap",
    "bench/route-shootout/servers/keala-bun.ts",
    "4342",
  ],
  { stdio: "ignore" },
);
const waitReady = async () => {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch("http://127.0.0.1:4342/status");
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("never ready");
};
try {
  await waitReady();
  await autocannon({
    url: "http://127.0.0.1:4342/user",
    connections: 200,
    duration: 10,
    pipelining: 1,
    workers: 4,
    warmup: { connections: 200, duration: 2 },
  });
  console.log("load done");
} finally {
  child.kill("SIGTERM");
  await sleep(1500);
}
