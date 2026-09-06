// Fresh-process per-module footprint: which core-graph module carries the
// ~7.8MB external allocation? Each probe is its own node process.
import { spawnSync } from "node:child_process";
const probe = (rel) => {
  const code = `import(${JSON.stringify(rel)}).then(() => {
      globalThis.gc();
      const m = process.memoryUsage();
      console.log("PROBE " + JSON.stringify({ rss: m.rss, heap: m.heapUsed, ext: m.external, arr: m.arrayBuffers }));
    });`;
  const res = spawnSync("node", ["--expose-gc", "--input-type=module", "--eval", code], {
    encoding: "utf8",
    cwd: "bench/route-shootout/diag",
  });
  const line = (res.stdout ?? "")
    .split("\n")
    .filter((l) => l.startsWith("PROBE "))
    .pop();
  if (line === undefined) return { err: (res.stderr ?? res.stdout ?? "?").slice(0, 120) };
  return JSON.parse(line.slice(6));
};
const MB = 1048576;
const MODULES = [
  ["bare", "node:util"],
  ["hono", "hono"],
  ["utils/mime", "../../../src/utils/mime.ts"],
  ["utils/query", "../../../src/utils/query.ts"],
  ["http/errors", "../../../src/http/errors.ts"],
  ["http/status", "../../../src/http/status.ts"],
  ["http/conditional", "../../../src/http/conditional.ts"],
  ["negotiation/accepts", "../../../src/negotiation/accepts.ts"],
  ["router/pattern", "../../../src/router/pattern.ts"],
  ["router/trie", "../../../src/router/trie.ts"],
  ["router/router", "../../../src/router/router.ts"],
  ["context/cookies", "../../../src/plugins/cookies/cookies.ts"],
  ["core/request-source", "../../../src/core/request-source.ts"],
  ["core/context/context", "../../../src/core/context/context.ts"],
  ["core/compose", "../../../src/core/compose.ts"],
  ["core/app (full graph)", "../../../src/core/app.ts"],
];
for (const [label, rel] of MODULES) {
  const r = probe(rel);
  if (r.err) {
    console.log(label.padEnd(24), "ERR", r.err.slice(0, 80));
    continue;
  }
  console.log(
    label.padEnd(24),
    `rss=${(r.rss / MB).toFixed(1).padStart(6)} heap=${(r.heap / MB).toFixed(1).padStart(5)} ext=${(r.ext / MB).toFixed(1).padStart(5)} arr=${(r.arr / MB).toFixed(1)}`,
  );
}
