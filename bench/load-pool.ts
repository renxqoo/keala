import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { aggregateLoad, splitConnections, type ClientSample } from "./load-metrics.ts";
import { nodeExecutable } from "./node-runtime.ts";

export interface LoadOptions {
  url: string;
  connections: number;
  processes: number;
  duration: number;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

interface Message {
  kind: string;
  error?: string;
  sample?: ClientSample;
}

const interruptible = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([operation(), cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

/** One sample owns its clients from spawn to exit, including on abort/failure. */
export const runLoad = async (
  options: LoadOptions,
  hooks: {
    beforeMeasurement?: (signal: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
    onSpawn?: (pid: number) => void;
  } = {},
) => {
  const counts = splitConnections(options.connections, options.processes);
  if (!Number.isSafeInteger(options.duration) || options.duration < 1)
    throw new TypeError("duration must be positive integer seconds");
  hooks.signal?.throwIfAborted();
  const clients: {
    child: ChildProcess;
    exited: Promise<void>;
    wait: (kind: string) => Promise<Message>;
  }[] = [];
  const abort = new AbortController();
  const onAbort = () => abort.abort(hooks.signal?.reason ?? new Error("load aborted"));
  hooks.signal?.addEventListener("abort", onAbort, { once: true });
  const watchdog = setTimeout(
    () => abort.abort(new Error("load sample deadline exceeded")),
    (options.duration + 30) * 1000,
  );
  try {
    for (let index = 0; index < counts.length; index++) {
      abort.signal.throwIfAborted();
      const child = spawn(
        nodeExecutable(),
        [fileURLToPath(new URL("./load-worker.mjs", import.meta.url))],
        {
          env: { ...process.env, NODE_ENV: "production" },
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        },
      );
      const messages: Message[] = [];
      let pending: ((message: Message) => void) | undefined;
      let failure: Error | undefined;
      const fail = (error: Error) => {
        failure = error;
        abort.abort(error);
      };
      const exited = new Promise<void>((resolve) => {
        child.once("exit", (code) => {
          if (code !== 0) fail(new Error(`load client exited with ${code}`));
          else if (!messages.some((m) => m.kind === "result") && !receivedResult)
            fail(new Error("load client exited without a result"));
          resolve();
        });
        child.once("error", (error) => {
          fail(error);
          resolve();
        });
      });
      let receivedResult = false;
      child.on("message", (raw: unknown) => {
        if (
          raw === null ||
          typeof raw !== "object" ||
          !("kind" in raw) ||
          !["ready", "warmed", "result", "error"].includes(String(raw.kind))
        ) {
          fail(new Error("invalid load client IPC message"));
          return;
        }
        const message = raw as Message;
        if (message.kind === "error") {
          fail(new Error(message.error));
          return;
        }
        if (message.kind === "result") receivedResult = true;
        if (pending !== undefined) pending(message);
        else messages.push(message);
      });
      const wait = (kind: string): Promise<Message> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => fail(new Error(`load client timed out waiting for ${kind}`)),
            (options.duration + 10) * 1000,
          );
          const cancel = () => finish(undefined, abort.signal.reason as Error);
          const finish = (message?: Message, error?: Error) => {
            clearTimeout(timer);
            abort.signal.removeEventListener("abort", cancel);
            pending = undefined;
            if (error !== undefined) reject(error);
            else if (message?.kind !== kind)
              reject(new Error(`expected ${kind}, received ${message?.kind}`));
            else resolve(message);
          };
          abort.signal.addEventListener("abort", cancel, { once: true });
          if (failure !== undefined || abort.signal.aborted) {
            finish(undefined, failure ?? (abort.signal.reason as Error));
            return;
          }
          const message = messages.shift();
          if (message !== undefined) finish(message);
          else pending = (value) => finish(value);
        });
      clients.push({ child, exited, wait });
      if (child.pid !== undefined) hooks.onSpawn?.(child.pid);
    }
    await Promise.all(clients.map((client) => client.wait("ready")));
    const send = (child: ChildProcess, message: object) => {
      child.send(message, (error) => {
        if (error != null) abort.abort(error);
      });
    };
    clients.forEach((client, index) =>
      send(client.child, {
        kind: "warmup",
        options: {
          url: options.url,
          duration: options.duration,
          method: options.method,
          body: options.body,
          headers: options.headers,
          connections: counts[index],
          pipelining: 1,
        },
      }),
    );
    await Promise.all(clients.map((client) => client.wait("warmed")));
    await interruptible(async () => {
      await hooks.beforeMeasurement?.(abort.signal);
    }, abort.signal);
    abort.signal.throwIfAborted();
    const at = Date.now() + 100;
    clients.forEach((client) => send(client.child, { kind: "run", at }));
    const results = await Promise.all(clients.map((client) => client.wait("result")));
    const exitDeadline = setTimeout(
      () => abort.abort(new Error("load client exit deadline exceeded")),
      2000,
    );
    try {
      await interruptible(() => Promise.all(clients.map((client) => client.exited)), abort.signal);
      abort.signal.throwIfAborted();
    } finally {
      clearTimeout(exitDeadline);
    }
    return aggregateLoad(
      results.map((message) => {
        if (message.sample === undefined) throw new Error("missing client sample");
        return message.sample;
      }),
    );
  } finally {
    clearTimeout(watchdog);
    hooks.signal?.removeEventListener("abort", onAbort);
    abort.abort(new Error("load pool closed"));
    await Promise.all(
      clients.map(async ({ child, exited }) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }
};
