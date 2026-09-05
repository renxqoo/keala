import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { runLoad } from "../../bench/load-pool.ts";

const fixture = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
};
const assertExited = (pids: number[]) => {
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
};

describe("R4.6 isolated load processes", () => {
  it("measures POST on independent production clients and reaps successful workers", async () => {
    let seen = 0;
    let wrong = 0;
    const server = await fixture((req, res) => {
      let payload = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        payload += chunk;
      });
      req.on("end", () => {
        seen++;
        if (req.method !== "POST" || payload !== '{"ok":true}') wrong++;
        res.setHeader("Content-Type", "application/json");
        res.end(payload);
      });
    });
    const pids: number[] = [];
    let warmupCount = 0;
    try {
      const result = await runLoad(
        {
          url: server.url,
          connections: 5,
          processes: 2,
          duration: 1,
          method: "POST",
          body: '{"ok":true}',
          headers: { "content-type": "application/json" },
        },
        {
          onSpawn: (pid) => pids.push(pid),
          beforeMeasurement: async () => {
            warmupCount = seen;
          },
        },
      );
      expect(warmupCount).toBeGreaterThan(0);
      expect(wrong).toBe(0);
      expect(seen).toBeGreaterThanOrEqual(warmupCount + result.total);
      expect(result.latency.totalCount).toBe(result.total);
      expect(result.rps).toBeGreaterThan(0);
      expect(result.clients.map((c) => c.connections)).toEqual([3, 2]);
      expect(new Set(result.clients.map((c) => c.pid))).toEqual(new Set(pids));
      for (const client of result.clients) {
        expect(client.pid).not.toBe(process.pid);
        expect(client.env).toBe("production");
        expect(client.runtimeVersion).toMatch(/^v\d+\./);
        expect(client.cpu.user + client.cpu.system).toBeGreaterThan(0);
      }
      assertExited(pids);
    } finally {
      await server.close();
    }
  }, 20000);

  it("fails non-2xx warmup and reaps every worker", async () => {
    const server = await fixture((_req, res) => {
      res.writeHead(500).end("failure");
    });
    const pids: number[] = [];
    try {
      await expect(
        runLoad(
          { url: server.url, connections: 2, processes: 2, duration: 1 },
          { onSpawn: (pid) => pids.push(pid) },
        ),
      ).rejects.toThrow(/failed|exited/);
      assertExited(pids);
    } finally {
      await server.close();
    }
  }, 15000);

  it("cancels while a pre-measurement hook is blocked and reaps workers", async () => {
    const server = await fixture((_req, res) => {
      res.end("ok");
    });
    const controller = new AbortController();
    const pids: number[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        runLoad(
          { url: server.url, connections: 1, processes: 1, duration: 1 },
          {
            signal: controller.signal,
            onSpawn: (pid) => pids.push(pid),
            beforeMeasurement: () => {
              timer = setTimeout(() => controller.abort(new Error("test cancellation")), 10);
              return new Promise(() => undefined);
            },
          },
        ),
      ).rejects.toThrow("test cancellation");
      assertExited(pids);
    } finally {
      clearTimeout(timer);
      await server.close();
    }
  }, 15000);

  it("does not spawn after pre-abort or invalid connection partition", async () => {
    const options = { url: "http://127.0.0.1:1", connections: 1, processes: 1, duration: 1 };
    const pids: number[] = [];
    const hooks = { onSpawn: (pid: number) => pids.push(pid) };
    await expect(
      runLoad(options, { ...hooks, signal: AbortSignal.abort(new Error("already cancelled")) }),
    ).rejects.toThrow("already cancelled");
    await expect(runLoad({ ...options, processes: 2 }, hooks)).rejects.toThrow();
    expect(pids).toEqual([]);
  });

  it("rejects an unreachable endpoint and reaps every client", async () => {
    const server = await fixture((_req, res) => {
      res.end("ok");
    });
    const url = server.url;
    await server.close();
    const pids: number[] = [];
    await expect(
      runLoad(
        { url, connections: 2, processes: 2, duration: 1 },
        { onSpawn: (pid) => pids.push(pid) },
      ),
    ).rejects.toThrow(/failed|exited/);
    assertExited(pids);
  }, 15000);

  it("cancels an active measurement and reaps every client", async () => {
    const server = await fixture((_req, res) => {
      res.end("ok");
    });
    const controller = new AbortController();
    const pids: number[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        runLoad(
          { url: server.url, connections: 2, processes: 2, duration: 3 },
          {
            signal: controller.signal,
            onSpawn: (pid) => pids.push(pid),
            beforeMeasurement: async () => {
              timer = setTimeout(() => controller.abort(new Error("measurement cancelled")), 400);
            },
          },
        ),
      ).rejects.toThrow("measurement cancelled");
      assertExited(pids);
    } finally {
      clearTimeout(timer);
      await server.close();
    }
  }, 15000);

  it("rejects unexpected worker death and reaps its siblings", async () => {
    const server = await fixture((_req, res) => {
      res.end("ok");
    });
    const pids: number[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        runLoad(
          { url: server.url, connections: 2, processes: 2, duration: 1 },
          {
            onSpawn: (pid) => {
              pids.push(pid);
              if (pids.length === 2) timer = setTimeout(() => process.kill(pid, "SIGKILL"), 100);
            },
          },
        ),
      ).rejects.toThrow("load client exited");
      assertExited(pids);
    } finally {
      clearTimeout(timer);
      await server.close();
    }
  }, 15000);

  it("cancels during startup and stops starting further workers", async () => {
    const controller = new AbortController();
    const pids: number[] = [];
    await expect(
      runLoad(
        { url: "http://127.0.0.1:1", connections: 4, processes: 4, duration: 1 },
        {
          signal: controller.signal,
          onSpawn: (pid) => {
            pids.push(pid);
            controller.abort(new Error("startup cancelled"));
          },
        },
      ),
    ).rejects.toThrow("startup cancelled");
    expect(pids).toHaveLength(1);
    assertExited(pids);
  });
});
