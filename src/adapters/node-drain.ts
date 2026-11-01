/** Observe FIFO wire completion per connection, only while draining. */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

const OBSERVED = Symbol("keala.drainObserved");
const heldCloses = new WeakSet<ServerResponse>();
interface Connection {
  socket: Socket;
  queued: number;
  last?: ServerResponse;
  watched?: ServerResponse;
}
type ObservedResponse = ServerResponse & { [OBSERVED]?: Connection };

/** Early-answer body cancellation must run even if finish already fired. */
export const holdNodeClose = (out: ServerResponse): void => {
  heldCloses.add(out);
};
export const releaseNodeClose = (out: ServerResponse): void => {
  heldCloses.delete(out);
};

export const createNodeDrainTracker = (server: Server) => {
  const connections = new Set<Connection>();
  const connectionBySocket = new WeakMap<Socket, Connection>();
  const pending = new Set<Connection>();
  let notify: (() => void) | undefined;
  const unwatch = (connection: Connection): void => {
    const out = connection.watched as ObservedResponse | undefined;
    if (out !== undefined) {
      out.off("close", responseClosed);
      out[OBSERVED] = undefined;
      connection.watched = undefined;
    }
  };
  function responseClosed(this: ObservedResponse): void {
    const connection = this[OBSERVED];
    if (connection === undefined || connection.last !== this) return;
    unwatch(connection);
    pending.delete(connection);
    notify?.();
  }
  const watch = (connection: Connection): void => {
    unwatch(connection);
    const out = connection.last as ObservedResponse | undefined;
    if (
      out === undefined ||
      (out.writableFinished && !heldCloses.has(out) && !connection.socket.destroyed)
    ) {
      pending.delete(connection);
      return;
    }
    pending.add(connection);
    connection.watched = out;
    out[OBSERVED] = connection;
    out.once("close", responseClosed);
  };
  server.on("connection", (socket: Socket) => {
    const connection: Connection = { socket, queued: 0 };
    connectionBySocket.set(socket, connection);
    connections.add(connection);
    socket.once("close", () => {
      unwatch(connection);
      connections.delete(connection);
      pending.delete(connection);
      connection.last = undefined;
      connectionBySocket.delete(socket);
      notify?.();
    });
  });
  return {
    get pending(): number {
      return pending.size;
    },
    track(incoming: IncomingMessage, out: ServerResponse): void {
      const connection = connectionBySocket.get(incoming.socket);
      if (connection === undefined) return;
      connection.last = out;
      if (notify !== undefined) watch(connection);
    },
    queue(incoming: IncomingMessage): (() => void) | undefined {
      const connection = connectionBySocket.get(incoming.socket);
      if (connection === undefined) return;
      connection.queued++;
      return () => {
        connection.queued--;
      };
    },
    start(onChange: () => void): void {
      notify = onChange;
      for (const connection of connections) watch(connection);
    },
    closeIdle(): void {
      for (const connection of connections) {
        const out = connection.last;
        if (
          connection.queued === 0 &&
          (out === undefined || (out.writableFinished && !heldCloses.has(out)))
        ) {
          connection.socket.destroy();
        }
      }
    },
    stop(): void {
      notify = undefined;
      for (const connection of pending) unwatch(connection);
      pending.clear();
    },
  };
};
