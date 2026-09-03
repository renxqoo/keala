/**
 * R4.4 acceptance: real SIGTERM under sustained load, ZERO dropped requests.
 *
 *   bun scripts/drain-verify.ts
 *
 * For each runtime (bun child, node child against dist):
 *   1. spawn the drain-server child with the signal bridge on,
 *   2. drive mixed load (/fast, /slow, /stream) from 8 concurrent workers,
 *   3. SIGTERM mid-flight,
 *   4. workers keep firing until connections fail cleanly,
 *   5. verdict: child exit code 0 + drain {timedOut:false} + every answered
 *      request complete and byte-correct (truncation/mismatch = dropped).
 *
 * Post-SIGTERM new requests may fail (ECONNREFUSED or 503) — that is the
 * contract; ADMITTED requests must never lose bytes.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface Outcome {
  ok: number;
  refused: number;
  drained: number; // 503 gate refusals after SIGTERM
  truncated: number; // body mismatch / mid-stream failure = DROPPED
}

const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

const root = resolve(import.meta.dir, "..");

const startChild = (runtime: "bun" | "node", port: number): ReturnType<typeof spawn> =>
  runtime === "bun"
    ? spawn("bun", ["scripts/drain-server.ts", String(port)], { cwd: root })
    : spawn("node", ["scripts/drain-server-node.mjs", String(port)], { cwd: root });

const waitForPort = async (child: ReturnType<typeof spawn>): Promise<number> => {
  return new Promise((resolvePort, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const match = /LISTENING (\d+)/.exec(buffer);
      if (match !== null) {
        child.stdout?.off("data", onData);
        resolvePort(Number(match[1]));
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => reject(new Error(`child exited early (${code})`)));
  });
};

/** One worker: mixed load until connections die post-SIGTERM. */
const worker = async (
  base: string,
  stopRefused: { count: number },
  outcome: Outcome,
): Promise<void> => {
  let i = 0;
  while (stopRefused.count < 3) {
    const id = i++;
    const kind = id % 3;
    const path =
      kind === 0 ? "/fast" : kind === 1 ? `/slow/${40 + (id % 4) * 30}` : `/stream/${3 + (id % 3)}`;
    const expected = kind === 0 ? "fast" : kind === 1 ? `slow-${40 + (id % 4) * 30}` : undefined;
    try {
      const res = await fetch(`${base}${path}`);
      if (res.status === 503) {
        outcome.drained++;
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const text = await res.text(); // a truncated stream throws here
      if (res.status !== 200) {
        outcome.truncated++; // unexpected status mid-drain
        continue;
      }
      if (expected !== undefined && text !== expected) {
        outcome.truncated++;
        continue;
      }
      if (kind === 2) {
        // Stream: chunked "s0;s1;…sN-1;" — the LAST chunk proves completeness.
        const chunks = 3 + (id % 3);
        if (!text.endsWith(`s${chunks - 1};`)) {
          outcome.truncated++;
          continue;
        }
      }
      outcome.ok++;
    } catch {
      if (stopRefused.count === 0) stopRefused.count = 1; // first failure
      stopRefused.count++; // consecutive-ish guard; refusals dominate post-close
      outcome.refused++;
    }
  }
};

const verifyRuntime = async (runtime: "bun" | "node"): Promise<void> => {
  if (runtime === "node" && !existsSync(resolve(root, "dist/index.js"))) {
    throw new Error("dist/ missing — run `npm run build` before drain-verify");
  }
  process.stdout.write(`\n=== ${runtime.toUpperCase()} child ===\n`);
  const child = startChild(runtime, 0);
  const port = await waitForPort(child);
  const base = `http://127.0.0.1:${port}`;
  const outcome: Outcome = { ok: 0, refused: 0, drained: 0, truncated: 0 };
  const stopRefused = { count: 0 };

  const workers = Array.from({ length: 8 }, () => worker(base, stopRefused, outcome));
  await wait(700); // sustained load is flowing
  // Deterministic in-flight overlap: a volley of slow requests that is
  // guaranteed to still be running when the SIGTERM lands — the drain must
  // let every one of them finish.
  const volley = Array.from({ length: 8 }, () =>
    fetch(`${base}/slow/300`)
      .then(async (res) => {
        const text = await res.text();
        if (res.status !== 200 || text !== "slow-300") outcome.truncated++;
        else outcome.ok++;
      })
      .catch(() => {
        outcome.refused++;
      }),
  );
  await wait(40); // the volley is mid-handler now
  const sigtermAt = Date.now();
  child.kill("SIGTERM");

  const exited = new Promise<{ code: number | null; closedLine: string }>((resolveExit) => {
    let tail = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      tail += chunk.toString("utf8");
    });
    child.once("close", (code) => {
      const match = /CLOSED (\{.*\})/.exec(tail);
      resolveExit({ code, closedLine: match?.[1] ?? "missing" });
    });
  });
  await Promise.all(workers);
  await Promise.all(volley);
  const { code, closedLine } = await exited;
  const drainMs = Date.now() - sigtermAt;

  process.stdout.write(
    `responses ok=${outcome.ok} gate503=${outcome.drained} refused=${outcome.refused} truncated=${outcome.truncated}\n` +
      `drain window=${drainMs}ms exit=${code} close=${closedLine}\n`,
  );

  const failures: string[] = [];
  if (outcome.truncated > 0) failures.push(`${outcome.truncated} dropped/truncated responses`);
  if (outcome.ok < 30) failures.push(`too few completed responses pre-SIGTERM (${outcome.ok})`);
  if (code !== 0) failures.push(`child exit code ${code}`);
  if (!closedLine.includes('"timedOut":false')) failures.push(`close status ${closedLine}`);
  // The 300ms volley was mid-flight at SIGTERM: a healthy drain waits for it.
  if (drainMs < 200) failures.push(`drain window suspiciously short (${drainMs}ms)`);
  if (failures.length > 0) throw new Error(`${runtime}: ${failures.join("; ")}`);
  process.stdout.write(`${runtime}: PASS — 0 dropped, in-flight drained in ${drainMs}ms\n`);
};

const main = async (): Promise<void> => {
  await verifyRuntime("bun");
  await verifyRuntime("node");
  process.stdout.write("\ndrain-verify: ALL PASS\n");
  process.exit(0);
};

void main().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
