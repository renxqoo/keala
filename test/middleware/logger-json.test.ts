/**
 * N7 logger JSON — the structured logging option of `logger()`.
 *
 * `format: "json"` turns the one-line-per-request log into a flat JSON
 * object (ts/method/path/status/duration_ms + request_id when the
 * requestId middleware ran + caller-supplied `fields`), for log shippers
 * that parse. The default "text" format must stay byte-identical to the
 * pre-JSON behavior — that is locked here too.
 */

import { describe, expect, it } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { logger, requestId } from "../../src/middleware/headers.ts";

const quiet = { env: "test" } as const;
const req = (path: string): Request => new Request(`http://localhost:3000${path}`);

describe("logger({ format: 'json' })", () => {
  it("emits one parsable JSON line with every base field", async () => {
    const lines: string[] = [];
    const app = new Keala(quiet);
    app.use(logger({ format: "json", write: (line) => lines.push(line) }));
    app.get("/api/users", (c) => c.text("ok"));
    await app.handle(req("/api/users"));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/api/users");
    expect(entry.status).toBe(200);
    expect(Number.isInteger(entry.duration_ms)).toBe(true); // Math.round-ed
    expect(typeof entry.ts).toBe("string");
    expect(entry.ts as string).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, // ISO 8601, ms precision
    );
  });

  it("carries request_id when the requestId middleware ran", async () => {
    const lines: string[] = [];
    const app = new Keala(quiet);
    app.use(requestId());
    app.use(logger({ format: "json", write: (line) => lines.push(line) }));
    app.get("/x", (c) => c.text("ok"));
    await app.handle(req("/x"));
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(typeof entry.request_id).toBe("string");
    expect((entry.request_id as string).length).toBeGreaterThan(0);
  });

  it("omits request_id entirely without the requestId middleware", async () => {
    const lines: string[] = [];
    const app = new Keala(quiet);
    app.use(logger({ format: "json", write: (line) => lines.push(line) }));
    app.get("/x", (c) => c.text("ok"));
    await app.handle(req("/x"));
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect("request_id" in entry).toBe(false);
  });

  it("flattens caller fields into every line", async () => {
    const lines: string[] = [];
    const app = new Keala(quiet);
    app.use(
      logger({
        format: "json",
        fields: { service: "my-api", env: "prod" },
        write: (line) => lines.push(line),
      }),
    );
    app.get("/a", (c) => c.text("ok"));
    app.get("/b", (c) => c.text("ok"));
    await app.handle(req("/a"));
    await app.handle(req("/b"));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry.service).toBe("my-api");
      expect(entry.env).toBe("prod");
    }
    expect((JSON.parse(lines[0] as string) as Record<string, unknown>).path).toBe("/a");
    expect((JSON.parse(lines[1] as string) as Record<string, unknown>).path).toBe("/b");
  });

  it("core fields win over same-named caller fields — the line stays truthful", async () => {
    const lines: string[] = [];
    const app = new Keala(quiet);
    app.use(requestId());
    app.use(
      logger({
        format: "json",
        // Hostile/spoofed field names: none of these may overwrite what the
        // request actually was.
        fields: {
          ts: "1970-01-01T00:00:00.000Z",
          method: "POST",
          path: "/spoofed",
          status: 500,
          duration_ms: -1,
          request_id: "spoofed-id",
          service: "real-extra",
        },
        write: (line) => lines.push(line),
      }),
    );
    app.get("/real", (c) => c.text("ok"));
    await app.handle(req("/real"));
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/real");
    expect(entry.status).toBe(200);
    expect(entry.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(entry.ts).not.toBe("1970-01-01T00:00:00.000Z");
    expect(String(entry.ts)).toMatch(/^2\d{3}-/);
    expect(entry.request_id).not.toBe("spoofed-id");
    expect(typeof entry.request_id).toBe("string");
    // Uncontested caller fields still flatten through.
    expect(entry.service).toBe("real-extra");
  });

  it("logs the thrown status on the error path, still as JSON", async () => {
    const lines: string[] = [];
    const app = new Keala(quiet);
    app.use(logger({ format: "json", write: (line) => lines.push(line) }));
    app.get("/e", (c) => {
      c.throw(503, "dependency down");
    });
    const res = await app.handle(req("/e"));
    expect(res.status).toBe(503);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry.status).toBe(503);
    expect(entry.path).toBe("/e");
    expect(String(entry.ts)).toMatch(/T.*Z/);
  });
});

describe("logger text format is unchanged", () => {
  it("default options keep the one-line human format", async () => {
    const lines: string[] = [];
    const app = new Keala(quiet);
    app.use(logger({ write: (line) => lines.push(line) }));
    app.get("/x", (c) => c.text("ok"));
    await app.handle(req("/x"));
    expect(lines[0]).toMatch(/^GET \/x -> 200 \d+ms -$/);
  });

  it('explicit format: "text" is the same line', async () => {
    const lines: string[] = [];
    const app = new Keala(quiet);
    app.use(logger({ format: "text", write: (line) => lines.push(line) }));
    app.get("/x", (c) => c.text("nope", 404));
    await app.handle(req("/x"));
    expect(lines[0]).toMatch(/^GET \/x -> 404 \d+ms -$/);
  });
});
