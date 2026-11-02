import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keala } from "../../index.ts";
import { serveStatic } from "../index.ts";

const original = "static representation";
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "keala-static-encoding-"));
  await writeFile(join(root, "asset.txt"), original);
  await writeFile(join(root, "asset.txt.br"), brotliCompressSync(original));
  await writeFile(join(root, "asset.txt.gz"), gzipSync(original));
  await writeFile(join(root, "gzip-only.txt"), original);
  await writeFile(join(root, "gzip-only.txt.gz"), gzipSync(original));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function request(path: string, accept: string, conditional: boolean) {
  const app = new Keala({ env: "test" });
  app.use(serveStatic({ root, precompressed: true }));
  const headers: Record<string, string> = { "accept-encoding": accept };
  if (conditional) headers["if-none-match"] = '"unmatched"';
  return app.handle(new Request(`http://localhost/${path}`, { headers }));
}

async function expectRepresentation(response: Response, encoding: string | null) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-encoding")).toBe(encoding);
  expect(response.headers.get("content-type")).toBe("text/plain");
  const decoded =
    encoding === "br"
      ? brotliDecompressSync(bytes)
      : encoding === "gzip"
        ? gunzipSync(bytes)
        : bytes;
  expect(new TextDecoder().decode(decoded)).toBe(original);
}

describe.each([false, true])("precompressed responses with conditional=%s", (conditional) => {
  it.each([
    ["br;q=0, *;q=1", "gzip"],
    ["*;q=1, br;q=0", "gzip"],
    ["br;q=0, gzip;q=0, *;q=1", null],
    ["*;q=1, br;q=0, gzip;q=0", null],
    ["br;q=0, x-gzip;q=0, *;q=1", null],
    ["br; q = 0, gzip; Q = 0, *;q=1", null],
    ["BR;Q=0, *;q=1", "gzip"],
  ] as const)(
    "does not re-enable explicitly refused encodings for %s",
    async (accept, encoding) => {
      const response = await request("asset.txt", accept, conditional);
      await expectRepresentation(response, encoding);
    },
  );

  it.each([
    ["", null],
    ["identity", null],
    ["*;q=0", null],
    ["br; q = 0", null],
    ["br;q=0, gzip; q = 0", null],
    ["x-gzip", "gzip"],
    ["gzip, *", "br"],
    ["*, gzip", "br"],
    ["gzip;q=1, br;q=0.1", "br"],
    ["*;q=0, br;q=0.5", "br"],
    ["*;q=0, gzip;q=0.5", "gzip"],
    ["br;q=bogus, gzip", "gzip"],
  ] as const)("serves the accepted representation for %s", async (accept, encoding) => {
    const response = await request("asset.txt", accept, conditional);
    await expectRepresentation(response, encoding);
  });

  it("tries an accepted gzip sibling when the preferred Brotli sibling is missing", async () => {
    const response = await request("gzip-only.txt", "br, gzip", conditional);
    await expectRepresentation(response, "gzip");
  });

  it("does not use a refused gzip sibling when the Brotli sibling is missing", async () => {
    const response = await request("gzip-only.txt", "br, gzip;q=0, *", conditional);
    await expectRepresentation(response, null);
  });
});
