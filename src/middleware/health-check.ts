/**
 * healthCheck — liveness/readiness probe endpoints, the k8s/Docker/Nomad
 * contract (N6).
 *
 * Two probes, two different questions:
 * - liveness (`/healthz`) answers "is the process alive?" and NOTHING else —
 *   always 200. Wiring it to a dependency check is the classic
 *   cascade-restart bug: when the dependency blips, every pod fails
 *   liveness, kubelet restarts them all, and the restart storm takes the
 *   dependency down harder.
 * - readiness (`/readyz`) answers "may this instance take traffic now?" —
 *   200 `{status:"ok"}` when the `ready` predicate says yes, 503 when it
 *   says no. A not-ready pod is dropped from the Service endpoints but
 *   never restarted.
 *
 * `ready()` throwing is a not-ready answer too, reported by the error's
 * NAME only (`{"status":"not ready","error":"TimeoutError"}`) — the
 * message can carry credentials or internal detail and never reaches the
 * wire. Mount it first so probes answer even while heavier middleware
 * (auth, body parsing) would reject real traffic:
 *
 * ```ts
 * app.use(healthCheck({ ready: async () => (await db.ping()) && cache.isUp() }));
 * ```
 */

import type { RouteHandler } from "../router/router.ts";

export interface HealthCheckOptions {
  /** Liveness endpoint. Default "/healthz" — always 200. */
  livenessPath?: string;
  /** Readiness endpoint. Default "/readyz" — 200/503 by the ready predicate. */
  readinessPath?: string;
  /** Readiness predicate (async allowed). Default `() => true`. */
  ready?: () => boolean | Promise<boolean>;
}

/** The error's name is safe to publish; its message never is. */
const nameOf = (err: unknown): string => (err instanceof Error ? err.name : "Error");

export const healthCheck = (options: HealthCheckOptions = {}): RouteHandler => {
  const livenessPath = options.livenessPath ?? "/healthz";
  const readinessPath = options.readinessPath ?? "/readyz";
  const ready = options.ready ?? ((): boolean => true);
  return async (c, next) => {
    // Probes are GET endpoints; HEAD rides along as its header-only view.
    if (c.method !== "GET" && c.method !== "HEAD") return next();
    // Liveness wins when both paths collide — the always-200 answer is the
    // one a shared path must give.
    if (c.path === livenessPath) return c.json({ status: "ok" }, 200);
    if (c.path === readinessPath) {
      try {
        if ((await ready()) === true) return c.json({ status: "ok" }, 200);
      } catch (err) {
        return c.json({ status: "not ready", error: nameOf(err) }, 503);
      }
      return c.json({ status: "not ready" }, 503);
    }
    return next();
  };
};
