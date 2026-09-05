// 每个测试文件不得超过 500 行（测试目录整理的硬性不变量）。
// 用法: node scripts/test-size-guard.mjs [dir=test] [max=500]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "test";
const max = Number(process.argv[3] ?? 500);

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.test\.ts$/.test(p) ? [p] : [];
  });

const readLines = (p) => {
  const text = readFileSync(p, "utf8");
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
};

const over = walk(root)
  .map((p) => [p, readLines(p)])
  .filter(([, n]) => n > max);

if (over.length) {
  console.error(`以下测试文件超过 ${max} 行:`);
  for (const [p, n] of over) console.error(`  ${n}\t${p}`);
  process.exit(1);
}
console.log(`✓ ${root} 下所有测试文件均 ≤ ${max} 行`);
