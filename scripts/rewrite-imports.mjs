import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const rewrite = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await rewrite(path);
    else if (entry.name.endsWith(".d.ts")) {
      const source = await readFile(path, "utf8");
      const patched = source.replaceAll('.ts"', '.js"');
      if (patched !== source) await writeFile(path, patched);
    }
  }
};

await rewrite(new URL("../dist", import.meta.url).pathname);
