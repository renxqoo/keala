import type { Kernel } from "./kernel.ts";

/** Experimental HTTP adapter. Native Bun owns request cancellation and drain. */
export function listenBun(kernel: Kernel, options: { port?: number; hostname?: string } = {}) {
  const executable = kernel.build();
  let closing = false;
  let closingPromise: Promise<{ forced: boolean }> | undefined;
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    fetch(request: Request) {
      return closing
        ? new Response("Service Unavailable", { status: 503 })
        : executable.fetch(request);
    },
  });
  return {
    port: server.port!,
    close(graceMs = 5000): Promise<{ forced: boolean }> {
      if (closingPromise) return closingPromise;
      if (!Number.isFinite(graceMs) || graceMs < 0) throw new RangeError("invalid grace period");
      closing = true;
      closingPromise = new Promise((resolve, reject) => {
        let forced = graceMs === 0;
        const timer = setTimeout(() => {
          forced = true;
          void server.stop(true).then(() => resolve({ forced }), reject);
        }, graceMs);
        void server.stop(forced).then(
          () => {
            clearTimeout(timer);
            resolve({ forced });
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      return closingPromise;
    },
  };
}
