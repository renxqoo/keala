import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { Keala } from "../../index.ts";
import { nodeExecutable } from "../../../bench/node-runtime.ts";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["synchronous", "asynchronous"])(
  "does not leave a timeout or report a second failure after a %s shutdown error",
  async (mode) => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("shutdown failed");
    const completed: string[] = [];
    const app = new Keala({ env: "test" });
    app.onShutdown(() => {
      completed.push("failed");
      if (mode === "synchronous") throw failure;
      return Promise.reject(failure);
    });
    app.onShutdown(() => {
      completed.push("next");
    });

    expect(await app.close({ shutdownTimeout: 100 })).toEqual({
      timedOut: false,
      inFlight: 0,
    });
    expect(completed).toEqual(["failed", "next"]);
    expect(errors).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("onShutdown handler #1 failed"),
      expect.stringContaining("shutdown failed"),
    );
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toHaveBeenCalledTimes(1);
    await app.close();
    expect(completed).toEqual(["failed", "next"]);
  },
);

it.each(["close", "unbounded close", "unbounded failure", "signal"])(
  "does not exit before later shutdown hooks run during %s with no other active handles",
  async (mode) => {
    const code = `
      import { Keala } from ${JSON.stringify(new URL("../../index.ts", import.meta.url).href)};
      import { listen } from ${JSON.stringify(new URL("../../adapters/node.ts", import.meta.url).href)};
      const app = new Keala({ env: "test" });
      await listen(app, { port: 0, hostname: "127.0.0.1", signals: true }).ready();
      app.onShutdown(() => {
        console.log("FIRST");
        return ${
          mode === "close"
            ? "new Promise(() => {})"
            : mode === "unbounded failure"
              ? 'Promise.reject(new Error("hook failed"))'
              : "new Promise((resolve) => setTimeout(resolve, 20).unref())"
        };
      });
      app.onShutdown(() => console.log("SECOND"));
      ${
        mode === "signal"
          ? 'console.log("READY");'
          : `await app.close({ shutdownTimeout: ${mode === "close" ? 40 : 0} }); console.log("CLOSED");`
      }
    `;
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          nodeExecutable(),
          ["--experimental-strip-types", "--input-type=module", "--eval", code],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        let signalled = false;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, 2000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (mode === "signal" && !signalled && stdout.includes("READY\n")) {
            signalled = true;
            child.kill("SIGTERM");
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => (stderr += chunk));
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (status) => {
          clearTimeout(timer);
          if (timedOut) reject(new Error(`shutdown child did not exit: ${stderr}`));
          else resolve({ status, stdout, stderr });
        });
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(
      mode === "signal" ? ["READY", "FIRST", "SECOND"] : ["FIRST", "SECOND", "CLOSED"],
    );
  },
);
