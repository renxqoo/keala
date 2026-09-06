/**
 * M4 metrics — the first unit suite for the zero-dependency registry.
 *
 * Locks the Prometheus text exposition format (HELP/TYPE lines, bucket `le`
 * boundaries, `+Inf`, `_count`/`_sum`), the status-class funnel (2xx / 4xx /
 * 5xx and the 3xx -> "other" bucket), the inclusive `<=` bucket edge, the
 * in-flight pairing under real request concurrency, the scrape page, and
 * monotonic accumulation across consecutive requests.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { Keala } from "../../src/core/app.ts";
import { metrics, type MetricsRegistry } from "../../src/middleware/metrics.ts";

const quiet = { env: "test" } as const;
const req = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost:3000${path}`, init);

/**
 * The registry's writer surface. `metrics()` itself narrows through the same
 * cast (the interface only publishes the read side), so the bucket-edge tests
 * drive `observe` directly with exact durations instead of racing the wall
 * clock.
 */
type RegistryWriter = MetricsRegistry & {
  observe(status: number, durationMs: number): void;
};
const writer = (registry: MetricsRegistry): RegistryWriter => registry as RegistryWriter;

/** One drained 200 request against a fresh family, returning its registry. */
const oneCountedRequest = async (): Promise<MetricsRegistry> => {
  const m = metrics();
  const app = new Keala(quiet);
  app.use(m.middleware);
  app.get("/x", (c) => c.text("ok"));
  await app.handle(req("/x"));
  return m.registry;
};

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Exposition format
// ---------------------------------------------------------------------------

interface Family {
  help: string;
  type: string;
  samples: string[];
}

/** Group an exposition body into per-family HELP/TYPE/samples structures. */
const parseExposition = (text: string): Map<string, Family> => {
  const families = new Map<string, Family>();
  let current: Family | undefined;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("# HELP ")) {
      const rest = line.slice("# HELP ".length);
      const name = rest.slice(0, rest.indexOf(" "));
      expect(families.has(name), `duplicate HELP for ${name}`).toBe(false);
      current = { help: rest.slice(rest.indexOf(" ") + 1), type: "", samples: [] };
      families.set(name, current);
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      const rest = line.slice("# TYPE ".length);
      const name = rest.slice(0, rest.indexOf(" "));
      expect(families.get(name), `TYPE for unknown family ${name}`).toBeDefined();
      families.get(name)!.type = rest.slice(rest.indexOf(" ") + 1);
      continue;
    }
    expect(current, `sample before any HELP line: ${line}`).toBeDefined();
    current!.samples.push(line);
  }
  return families;
};

describe("registry.text() — Prometheus exposition format", () => {
  it("a fresh registry still exposes every family at zero", () => {
    const text = metrics().registry.text();
    const families = parseExposition(text);
    expect(families.get("keala_requests_total")!.samples).toContain("keala_requests_total 0");
    expect(families.get("keala_in_flight")!.samples).toEqual(["keala_in_flight 0"]);
    expect(text).toContain("keala_request_duration_ms_count 0");
    expect(text).toContain("keala_request_duration_ms_sum 0");
  });

  it("every family carries a HELP and a TYPE before its samples", async () => {
    const families = parseExposition((await oneCountedRequest()).text());
    expect([...families.keys()]).toEqual([
      "keala_requests_total",
      "keala_in_flight",
      "keala_request_duration_ms",
    ]);
    const expected: Record<string, string> = {
      keala_requests_total: "counter",
      keala_in_flight: "gauge",
      keala_request_duration_ms: "histogram",
    };
    for (const [name, type] of Object.entries(expected)) {
      const family = families.get(name)!;
      expect(family.help.length, `${name} HELP text`).toBeGreaterThan(0);
      expect(family.type).toBe(type);
      expect(family.samples.length, `${name} has samples`).toBeGreaterThan(0);
    }
  });

  it("sample lines are `<name>{<labels>}? <number>` and labeled values are numeric", async () => {
    const text = (await oneCountedRequest()).text();
    const sampleLine = /^(keala_[a-z_]+)(\{[^}]*\})? (-?\d+(?:\.\d+)?)$/;
    let samples = 0;
    for (const line of text.split("\n")) {
      if (line === "" || line.startsWith("#")) continue;
      const match = sampleLine.exec(line);
      expect(match, `malformed sample line: ${line}`).not.toBeNull();
      const value = match?.[3];
      expect(value, `sample value on line: ${line}`).toBeDefined();
      expect(Number.isNaN(Number.parseFloat(value as string))).toBe(false);
      samples++;
    }
    // bare total + 4 class-labeled totals + in_flight + 12 buckets + count + sum
    expect(samples).toBe(20);
  });

  it("the counter family emits the bare total plus one labeled series per class", async () => {
    const families = parseExposition((await oneCountedRequest()).text());
    expect(families.get("keala_requests_total")!.samples).toEqual([
      "keala_requests_total 1",
      'keala_requests_total{status="2xx"} 1',
      'keala_requests_total{status="4xx"} 0',
      'keala_requests_total{status="5xx"} 0',
      'keala_requests_total{status="other"} 0',
    ]);
  });

  it("the histogram emits cumulative buckets with the exact le ladder ending in +Inf", async () => {
    const families = parseExposition((await oneCountedRequest()).text());
    const samples = families.get("keala_request_duration_ms")!.samples;
    const buckets = samples.filter((line) => line.includes("_bucket{le="));
    const ladder = ["1", "2", "5", "10", "20", "50", "100", "250", "500", "1000", "2500", "+Inf"];
    expect(buckets).toEqual(ladder.map((le) => `keala_request_duration_ms_bucket{le="${le}"} 1`));
    // Every observed request is <= +Inf and the ladder is cumulative, so each
    // bucket after observation holds at least its lower neighbor's count.
    const counts = buckets.map((line) =>
      Number.parseInt(line.slice(line.lastIndexOf(" ") + 1), 10),
    );
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i] ?? 0).toBeGreaterThanOrEqual(counts[i - 1] ?? 0);
    }
    // The histogram closes with _count and _sum series. The in-process
    // request is sub-millisecond, so the sum is 0 or 1 wall-clock ms — the
    // exact-duration contracts live in the faked-clock tests below.
    expect(samples).toContain("keala_request_duration_ms_count 1");
    expect(samples.at(-1)).toMatch(/^keala_request_duration_ms_sum (0|1)$/);
  });
});

// ---------------------------------------------------------------------------
// Bucket edges — the `<=` at metrics.ts:93
// ---------------------------------------------------------------------------

describe("histogram bucket edges", () => {
  it("a duration EQUAL to a bound lands inside that bucket (inclusive <=)", () => {
    const registry = metrics().registry;
    writer(registry).observe(200, 10);
    const buckets = registry.snapshot().durationMs.buckets;
    expect(buckets.get(5)).toBe(0);
    expect(buckets.get(10)).toBe(1);
    expect(buckets.get(20)).toBe(1);
    expect(buckets.get(Infinity)).toBe(1);
  });

  it("a duration one past the bound skips to the NEXT bucket only", () => {
    const registry = metrics().registry;
    writer(registry).observe(200, 11);
    const buckets = registry.snapshot().durationMs.buckets;
    expect(buckets.get(10)).toBe(0);
    expect(buckets.get(20)).toBe(1);
  });

  it("sub-millisecond durations still land in the le=1 bucket, never leak past +Inf", () => {
    const registry = metrics().registry;
    const w = writer(registry);
    w.observe(200, 0);
    w.observe(200, 1);
    const buckets = registry.snapshot().durationMs.buckets;
    expect(buckets.get(1)).toBe(2);
    expect(buckets.get(2)).toBe(2);
    expect(buckets.get(Infinity)).toBe(2);
  });

  it("a real request measured on a faked clock lands exactly on its edge", async () => {
    vi.useFakeTimers();
    const m = metrics();
    const app = new Keala(quiet);
    app.use(m.middleware);
    app.get("/x", async (c) => {
      vi.advanceTimersByTime(10);
      return c.text("ok");
    });
    await app.handle(req("/x"));
    const text = m.registry.text();
    expect(text).toContain('keala_request_duration_ms_bucket{le="5"} 0');
    expect(text).toContain('keala_request_duration_ms_bucket{le="10"} 1');
    expect(text).toContain("keala_request_duration_ms_count 1");
    expect(text).toContain("keala_request_duration_ms_sum 10");
  });
});

// ---------------------------------------------------------------------------
// Status-class funnel
// ---------------------------------------------------------------------------

describe("status-class accounting", () => {
  it("a plain 200 response counts into 2xx and requestsTotal", async () => {
    const m = metrics();
    const app = new Keala(quiet);
    app.use(m.middleware);
    app.get("/x", (c) => c.text("ok"));
    const res = await app.handle(req("/x"));
    expect(res.status).toBe(200);
    const snap = m.registry.snapshot();
    expect(snap.requestsTotal).toBe(1);
    expect(snap.byClass).toEqual({ "2xx": 1, "4xx": 0, "5xx": 0, other: 0 });
  });

  it("a synchronous plain throw is observed as 5xx", async () => {
    const m = metrics();
    const app = new Keala(quiet);
    app.use(m.middleware);
    app.get("/e", () => {
      throw new Error("boom");
    });
    const res = await app.handle(req("/e"));
    expect(res.status).toBe(500);
    const snap = m.registry.snapshot();
    expect(snap.byClass["5xx"]).toBe(1);
    expect(snap.byClass["2xx"]).toBe(0);
    expect(snap.requestsTotal).toBe(1);
  });

  it("c.throw(418) keeps its own status and counts into 4xx", async () => {
    const m = metrics();
    const app = new Keala(quiet);
    app.use(m.middleware);
    app.get("/e", (c) => {
      c.throw(418, "teapot");
    });
    const res = await app.handle(req("/e"));
    expect(res.status).toBe(418);
    const snap = m.registry.snapshot();
    expect(snap.byClass["4xx"]).toBe(1);
    expect(snap.byClass["5xx"]).toBe(0);
    expect(snap.requestsTotal).toBe(1);
  });

  it("an async rejection is observed as 5xx", async () => {
    const m = metrics();
    const app = new Keala(quiet);
    app.use(m.middleware);
    app.get("/e", async () => {
      throw new Error("async boom");
    });
    const res = await app.handle(req("/e"));
    expect(res.status).toBe(500);
    const snap = m.registry.snapshot();
    expect(snap.byClass["5xx"]).toBe(1);
    expect(snap.durationMs.count).toBe(1);
  });

  it("a 302 redirect lands in the other bucket, not 2xx/4xx/5xx", async () => {
    const m = metrics();
    const app = new Keala(quiet);
    app.use(m.middleware);
    app.get("/r", (c) => c.redirect("/elsewhere"));
    const res = await app.handle(req("/r"));
    expect(res.status).toBe(302);
    const snap = m.registry.snapshot();
    expect(snap.byClass.other).toBe(1);
    expect(snap.byClass["2xx"]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// In-flight gauge pairing
// ---------------------------------------------------------------------------

/** A deferred the handler parks on so the request stays in flight. */
const gate = (): { promise: Promise<void>; release: () => void } => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
};

describe("in-flight pairing", () => {
  it("starts and settles at zero", async () => {
    const m = metrics();
    const app = new Keala(quiet);
    app.use(m.middleware);
    app.get("/x", (c) => c.text("ok"));
    expect(m.registry.snapshot().inFlight).toBe(0);
    await app.handle(req("/x"));
    expect(m.registry.snapshot().inFlight).toBe(0);
  });

  it("increments per admitted request and decrements as each settles", async () => {
    const m = metrics();
    const app = new Keala(quiet);
    app.use(m.middleware);
    const first = gate();
    const second = gate();
    app.get("/a", async (c) => {
      await first.promise;
      return c.text("a");
    });
    app.get("/b", async (c) => {
      await second.promise;
      return c.text("b");
    });

    const pendingA = app.handle(req("/a"));
    const pendingB = app.handle(req("/b"));
    // Let the (microtask-driven) chains run until both handlers park on their
    // gates — both requests are admitted but not settled.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(m.registry.snapshot().inFlight).toBe(2);

    first.release();
    expect((await pendingA).status).toBe(200);
    expect(m.registry.snapshot().inFlight).toBe(1);

    second.release();
    expect((await pendingB).status).toBe(200);
    expect(m.registry.snapshot().inFlight).toBe(0);
    expect(m.registry.snapshot().requestsTotal).toBe(2);
  });

  it("a thrown request still releases its in-flight slot", async () => {
    const m = metrics();
    const app = new Keala(quiet);
    app.use(m.middleware);
    app.get("/e", () => {
      throw new Error("boom");
    });
    await app.handle(req("/e"));
    expect(m.registry.snapshot().inFlight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The scrape page
// ---------------------------------------------------------------------------

describe("metrics.page", () => {
  it("serves the exposition body with the Prometheus content type", async () => {
    const m = metrics();
    const app = new Keala(quiet);
    app.use(m.middleware);
    app.get("/metrics", m.page);
    app.get("/x", (c) => c.text("ok"));
    await app.handle(req("/x"));
    const res = await app.handle(req("/metrics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("# HELP keala_requests_total Total completed requests.");
    expect(body).toContain("# TYPE keala_requests_total counter");
    expect(body).toContain("keala_requests_total 1");
    expect(body).toContain('keala_requests_total{status="2xx"} 1');
    // The scrape observes the registry BEFORE its own request is counted.
    expect(body).toContain("keala_request_duration_ms_count 1");
  });
});

// ---------------------------------------------------------------------------
// Consecutive accumulation
// ---------------------------------------------------------------------------

describe("consecutive requests", () => {
  it("counts and the duration histogram sum accumulate monotonically", async () => {
    vi.useFakeTimers();
    const m = metrics();
    const app = new Keala(quiet);
    app.use(m.middleware);
    app.get("/a", async (c) => {
      vi.advanceTimersByTime(5);
      return c.text("a");
    });
    app.get("/b", async (c) => {
      vi.advanceTimersByTime(7);
      return c.text("b");
    });
    await app.handle(req("/a"));
    let snap = m.registry.snapshot();
    expect(snap.requestsTotal).toBe(1);
    expect(snap.durationMs.count).toBe(1);
    expect(snap.durationMs.sum).toBe(5);

    await app.handle(req("/b"));
    snap = m.registry.snapshot();
    expect(snap.requestsTotal).toBe(2);
    expect(snap.byClass["2xx"]).toBe(2);
    expect(snap.durationMs.count).toBe(2);
    expect(snap.durationMs.sum).toBe(12);
    expect(snap.inFlight).toBe(0);

    const text = m.registry.text();
    expect(text).toContain("keala_request_duration_ms_count 2");
    expect(text).toContain("keala_request_duration_ms_sum 12");
    expect(text).toContain("keala_requests_total 2");
  });
});
