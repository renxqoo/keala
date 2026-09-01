// R4.2 router-scale matrix orchestrator.
//
//   node bench/run-router-scale.mjs [rounds]
//
// Spawns `bun bench/router-scale.ts` fresh processes for every
// (kind × size × framework) cell, rotating which framework leads each round
// so neither owns a systematically colder window. Aggregates round medians
// into a markdown table (keala vs Hono ratio per probe) and dumps raw JSON
// to bench/router-scale-results.json. Cells failing their in-process
// correctness assertions abort the whole run — perf numbers without correct
// behavior are void.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const KINDS = ["static", "param-distinct", "param-shared"];
const SIZES = [1, 10, 100, 1000, 10000];
const ROUNDS = Number(process.argv[2] ?? 4);
if (!Number.isInteger(ROUNDS) || ROUNDS < 1) {
  throw new TypeError("rounds must be a positive integer (this writes the results artifact)");
}
const PROBES = ["hit-mid", "hit-last", "miss-global", "miss-deep"];

const runCell = (framework, kind, size) =>
  new Promise((resolve, reject) => {
    const child = spawn("bun", ["bench/router-scale.ts", framework, kind, String(size)], {
      cwd: new URL("..", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      const line = stdout
        .trimEnd()
        .split("\n")
        .findLast((l) => l.startsWith("{"));
      if (code !== 0 || line === undefined) {
        reject(new Error(`${framework} ${kind} ${size} exited ${code}\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(new Error(`${framework} ${kind} ${size} bad output: ${line}\n${err}`));
      }
    });
  });

const median = (nums) => {
  const sorted = nums.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? NaN;
};

// cells[kind][size][framework] = array of per-round results
const cells = {};
for (const kind of KINDS) cells[kind] = {};
for (const kind of KINDS) {
  for (const size of SIZES) {
    cells[kind][size] = { keala: [], hono: [] };
  }
}

for (let round = 0; round < ROUNDS; round++) {
  // Alternate which framework leads each round (ABAB lead rotation).
  const order = round % 2 === 0 ? ["keala", "hono"] : ["hono", "keala"];
  for (const kind of KINDS) {
    for (const size of SIZES) {
      for (const framework of order) {
        const result = await runCell(framework, kind, size);
        cells[kind][size][framework].push(result);
        process.stdout.write(
          `r${round} ${framework.padEnd(5)} ${kind.padEnd(14)} n=${String(size).padEnd(5)} ` +
            `reg=${String(result.regMs).padStart(7)}ms first=${String(result.firstMs).padStart(6)}ms ` +
            PROBES.map((p) => `${p}=${result.probes[p].median}ns`).join(" ") +
            "\n",
        );
      }
    }
  }
}

await writeFile(
  new URL("./router-scale-results.json", import.meta.url),
  JSON.stringify(cells, null, 2),
);

const lines = [];
lines.push(`# R4.2 router-scale matrix — ${ROUNDS} rotating rounds, medians of round medians`);
lines.push("");
lines.push("ns/req (in-process, fresh process per cell per round). Ratio = keala/hono.");
lines.push("");
for (const kind of KINDS) {
  lines.push(`## ${kind}`);
  lines.push("");
  lines.push("| size | probe | keala | hono | ratio | keala IQR | hono IQR |");
  lines.push("| ---: | --- | ---: | ---: | ---: | --- | --- |");
  for (const size of SIZES) {
    const kealaRounds = cells[kind][size].keala;
    const honoRounds = cells[kind][size].hono;
    const kReg = median(kealaRounds.map((r) => r.regMs));
    const hReg = median(honoRounds.map((r) => r.regMs));
    for (const probe of PROBES) {
      const k = kealaRounds.map((r) => r.probes[probe].median);
      const h = honoRounds.map((r) => r.probes[probe].median);
      const kMed = median(k);
      const hMed = median(h);
      const kSpread = kealaRounds.map((r) => `${r.probes[probe].p25}–${r.probes[probe].p75}`);
      const hSpread = honoRounds.map((r) => `${r.probes[probe].p25}–${r.probes[probe].p75}`);
      lines.push(
        `| ${size} | ${probe} | ${Math.round(kMed)} | ${Math.round(hMed)} | ` +
          `${(kMed / hMed).toFixed(2)}x | ${kSpread.join(" / ")} | ${hSpread.join(" / ")} |`,
      );
    }
    lines.push(
      `| ${size} | regMs | ${kReg.toFixed(1)} | ${hReg.toFixed(1)} | ${(kReg / hReg).toFixed(2)}x | | |`,
    );
    lines.push(
      `| ${size} | firstMs | ${median(kealaRounds.map((r) => r.firstMs)).toFixed(1)} | ` +
        `${median(honoRounds.map((r) => r.firstMs)).toFixed(1)} | | | |`,
    );
    lines.push(
      `| ${size} | heapMB | ${median(kealaRounds.map((r) => r.heapMB)).toFixed(1)} | ` +
        `${median(honoRounds.map((r) => r.heapMB)).toFixed(1)} | | | |`,
    );
  }
  lines.push("");
}
const report = lines.join("\n");
console.log(report);
