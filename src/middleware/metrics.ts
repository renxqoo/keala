/**
 * metrics — zero-dependency request counters with Prometheus text output.
 *
 * `metrics()` is the collect middleware (runs first in the onion; status is
 * read after next() settles). `metricsPage()` renders the exposition text
 * for a scrape endpoint. Duration is wall-clock (Date.now) — good enough for
 * coarse service monitoring; histogram buckets are fixed powers-of-two in ms
 * so the output is stable across runtimes.
 */

import type { RouteHandler } from "../router/router.ts";

export interface MetricsSnapshot {
  requestsTotal: number;
  /** Status-class counters: "2xx" | "4xx" | "5xx" | "other". */
  byClass: Record<string, number>;
  inFlight: number;
  /** Wall-clock request durations in ms, bucketed. */
  durationMs: {
    buckets: ReadonlyMap<number, number>;
    count: number;
    sum: number;
  };
}

export interface MetricsRegistry {
  readonly snapshot: () => MetricsSnapshot;
  readonly text: () => string;
}

const BUCKET_BOUNDS = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2500, Infinity] as const;

const classOf = (status: number): string =>
  status >= 200 && status < 300
    ? "2xx"
    : status >= 400 && status < 500
      ? "4xx"
      : status >= 500
        ? "5xx"
        : "other";

/** Final status of a thrown error (HttpError carries it; anything else is 500). */
const statusOf = (error: unknown): number =>
  typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: number }).status)
    : 500;

const createRegistry = (): MetricsRegistry => {
  const byClass: Record<string, number> = { "2xx": 0, "4xx": 0, "5xx": 0, other: 0 };
  const buckets = new Map<number, number>(BUCKET_BOUNDS.map((bound) => [bound, 0]));
  let requestsTotal = 0;
  let inFlight = 0;
  let durationCount = 0;
  let durationSum = 0;
  const snapshot = (): MetricsSnapshot => ({
    requestsTotal,
    byClass: { ...byClass },
    inFlight,
    durationMs: { buckets: new Map(buckets), count: durationCount, sum: durationSum },
  });
  const text = (): string => {
    const snap = snapshot();
    let out = "";
    out += "# HELP keala_requests_total Total completed requests.\n";
    out += "# TYPE keala_requests_total counter\n";
    out += `keala_requests_total ${snap.requestsTotal}\n`;
    for (const name of ["2xx", "4xx", "5xx", "other"]) {
      out += `keala_requests_total{status="${name}"} ${snap.byClass[name] ?? 0}\n`;
    }
    out += "# HELP keala_in_flight Requests admitted but not settled.\n";
    out += "# TYPE keala_in_flight gauge\n";
    out += `keala_in_flight ${snap.inFlight}\n`;
    out += "# HELP keala_request_duration_ms Wall-clock request duration.\n";
    out += "# TYPE keala_request_duration_ms histogram\n";
    const bounds = [...snap.durationMs.buckets.entries()];
    for (const [bound, count] of bounds) {
      const label = bound === Infinity ? "+Inf" : String(bound);
      out += `keala_request_duration_ms_bucket{le="${label}"} ${count}\n`;
    }
    out += `keala_request_duration_ms_count ${snap.durationMs.count}\n`;
    out += `keala_request_duration_ms_sum ${snap.durationMs.sum}\n`;
    return out;
  };
  return {
    snapshot,
    text,
    observe(status: number, durationMs: number): void {
      requestsTotal++;
      byClass[classOf(status)] = (byClass[classOf(status)] ?? 0) + 1;
      durationCount++;
      durationSum += durationMs;
      for (const bound of BUCKET_BOUNDS) {
        if (durationMs <= bound) buckets.set(bound, (buckets.get(bound) ?? 0) + 1);
      }
    },
    enter(): void {
      inFlight++;
    },
    leave(): void {
      inFlight--;
    },
  } as MetricsRegistry;
};

export interface Metrics {
  /** Collect middleware — mount FIRST so it wraps the whole onion. */
  middleware: RouteHandler;
  /** Scrape endpoint handler. */
  page: RouteHandler;
  readonly registry: MetricsRegistry;
}

/** Create one metrics family per app (or share across apps explicitly). */
export const metrics = (): Metrics => {
  const registry = createRegistry() as MetricsRegistry & {
    observe(status: number, durationMs: number): void;
    enter(): void;
    leave(): void;
  };
  const middleware: RouteHandler = (c, next) => {
    registry.enter();
    const startedAt = Date.now();
    const finish = (): unknown => {
      registry.leave();
      registry.observe(c.status, Date.now() - startedAt);
      return undefined;
    };
    let result: unknown;
    try {
      result = next();
    } catch (error) {
      // A sync throw (c.throw) escapes next() directly; observe the thrown
      // HttpError status — the error funnel runs after the onion unwinds.
      registry.leave();
      registry.observe(statusOf(error), Date.now() - startedAt);
      throw error;
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          finish();
          return value as never;
        },
        (error: unknown) => {
          // A rejected next() carries the thrown status (see statusOf).
          registry.leave();
          registry.observe(statusOf(error), Date.now() - startedAt);
          throw error;
        },
      );
    }
    finish();
    return result as never;
  };
  const page: RouteHandler = (c) => {
    c.set("content-type", "text/plain; version=0.0.4; charset=utf-8");
    c.body = registry.text();
  };
  return { middleware, page, registry };
};
