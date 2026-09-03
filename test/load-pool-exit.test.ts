import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLoad } from "../bench/load-pool.ts";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
const require = createRequire(import.meta.url);
const hdr = require("hdr-histogram-js") as {
  build(): { recordValueWithCount(value: number, count: number): void };
  encodeIntoCompressedBase64(value: unknown): string;
};

/** Script only the IPC peer, so result -> exit races are deterministic. */
class Client extends EventEmitter {
  pid = 123;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kills: string[] = [];
  onResult: () => void = () => undefined;
  send(message: { kind: string }, callback: (error: Error | null) => void) {
    callback(null);
    queueMicrotask(() => {
      if (message.kind === "warmup") {
        this.emit("message", { kind: "warmed" });
        return;
      }
      const histogram = hdr.build();
      histogram.recordValueWithCount(1, 100);
      this.emit("message", {
        kind: "result",
        sample: {
          pid: this.pid,
          env: "production",
          runtimeVersion: "v22.20.0",
          connections: 1,
          startedAt: 1000,
          finishedAt: 2000,
          cpu: { user: 1000, system: 0, elapsedUs: 1000000 },
          result: {
            totalCompletedRequests: 100,
            errors: 0,
            timeouts: 0,
            non2xx: 0,
            mismatches: 0,
            latencies: hdr.encodeIntoCompressedBase64(histogram),
          },
        },
      });
      this.onResult();
    });
    return true;
  }
  finish(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, null);
  }
  kill(signal: string) {
    this.kills.push(signal);
    setImmediate(() => this.finish(0));
    return true;
  }
}

const setup = () => {
  const client = new Client();
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => client.emit("message", { kind: "ready" }));
    return client as unknown as ReturnType<typeof spawn>;
  });
  return client;
};
const options = { url: "http://127.0.0.1:1", connections: 1, processes: 1, duration: 1 };
afterEach(() => {
  vi.clearAllMocks();
});

describe("B46-7 result is not success until the client exits", () => {
  it("rejects cancellation after result but before worker exit", async () => {
    const client = setup();
    const controller = new AbortController();
    client.onResult = () => {
      setImmediate(() => controller.abort(new Error("late cancellation")));
    };
    await expect(runLoad(options, { signal: controller.signal })).rejects.toThrow(
      "late cancellation",
    );
    expect(client.exitCode).not.toBeNull();
  });
  it("rejects a worker that reports data then crashes", async () => {
    const client = setup();
    client.onResult = () => {
      setImmediate(() => client.finish(1));
    };
    await expect(runLoad(options)).rejects.toThrow("exited with 1");
  });
  it("accepts orderly exit without prematurely signalling the worker", async () => {
    const client = setup();
    client.onResult = () => {
      setImmediate(() => client.finish(0));
    };
    expect((await runLoad(options)).total).toBe(100);
    expect(client.kills).toEqual([]);
  });
  it("bounds result-without-exit and reaps the stalled worker", async () => {
    const client = setup();
    await expect(runLoad(options)).rejects.toThrow("exit deadline");
    expect(client.kills).toEqual(["SIGTERM"]);
    expect(client.exitCode).not.toBeNull();
  }, 5000);
});
