// Does the compiled dist (JS, no type-stripping) shed the ~8MB wasm?
import { spawnSync } from "node:child_process";
const probe = (label, spec, cwd) => {
  const code = `import(${JSON.stringify(spec)}).then(async (m) => {
      const app = m.Keala ? new m.Keala({ env: "production" }) : null;
      if (app) app.get("/x", (c) => c.text("x"));
      globalThis.gc();
      const mu = process.memoryUsage();
      console.log("PROBE " + JSON.stringify({ rss: mu.rss, heap: mu.heapUsed, ext: mu.external }));
    });`;
  const res = spawnSync("node", ["--expose-gc", "--input-type=module", "--eval", code], {
    encoding: "utf8",
    cwd,
  });
  const line = (res.stdout ?? "")
    .split("\n")
    .filter((l) => l.startsWith("PROBE "))
    .pop();
  if (line === undefined) return console.log(label, "ERR", (res.stderr ?? "?").slice(0, 100));
  const { rss, heap, ext } = JSON.parse(line.slice(6));
  console.log(
    `${label.padEnd(34)} rss=${(rss / 1048576).toFixed(1).padStart(6)} heap=${(heap / 1048576).toFixed(1).padStart(5)} ext=${(ext / 1048576).toFixed(1).padStart(5)}`,
  );
};
probe("hono (compiled js)", "hono", ".");
probe("keala SRC (.ts, type-strip)", "./src/index.ts", ".");
probe("keala DIST (compiled js)", "./dist/index.js", ".");
