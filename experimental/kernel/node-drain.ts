import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

const OWNER = Symbol("kernel.connection");
interface Connection {
  socket: OwnedSocket;
  queued: Set<OwnedResponse>;
  last?: OwnedResponse;
  watched?: OwnedResponse;
}
type OwnedSocket = Socket & { [OWNER]?: Connection };
type OwnedResponse = ServerResponse & { [OWNER]?: Connection };

/** Native HTTP/1 FIFO completion; bound responses pay no per-request listeners. */
export const nodeDrain = (server: Server, changed: () => void) => {
  const connections = new Set<Connection>();
  let draining = false;
  const unwatch = (connection: Connection): void => {
    connection.watched?.off("finish", wireDone);
    connection.watched?.off("close", wireDone);
    connection.watched = undefined;
  };
  function wireDone(this: OwnedResponse): void {
    const connection = this[OWNER];
    if (!connection) return;
    connection.queued.delete(this);
    if (connection.watched === this) unwatch(connection);
    if (draining) changed();
  }
  function socketClosed(this: OwnedSocket): void {
    const connection = this[OWNER];
    if (!connection) return;
    unwatch(connection);
    connections.delete(connection);
    connection.queued.clear();
    this[OWNER] = undefined;
    if (draining) changed();
  }
  const watch = (connection: Connection): void => {
    const out = connection.last;
    if (!out || out.writableFinished || out.destroyed || connection.watched === out) return;
    unwatch(connection);
    connection.watched = out;
    out[OWNER] = connection;
    out.once("finish", wireDone);
    out.once("close", wireDone);
  };
  server.on("connection", (socket: OwnedSocket) => {
    const connection: Connection = { socket, queued: new Set() };
    socket[OWNER] = connection;
    connections.add(connection);
    socket.once("close", socketClosed);
  });
  const closeIdle = (): void => {
    for (const connection of connections) {
      const last = connection.last;
      if (connection.queued.size === 0 && (!last || last.writableFinished || last.destroyed))
        connection.socket.destroy();
    }
  };
  // Node's close() calls this method synchronously. Its native idle test can
  // see writableEnded while a large end(body) still has buffered output.
  server.closeIdleConnections = closeIdle;
  return {
    track(incoming: IncomingMessage, out: OwnedResponse): void {
      const connection = (incoming.socket as OwnedSocket)[OWNER];
      if (!connection) return;
      if (out.socket === incoming.socket) {
        unwatch(connection);
        connection.last = out;
        if (draining) watch(connection);
      } else {
        connection.queued.add(out);
        out[OWNER] = connection;
        // An unassigned response can close before its predecessor finishes;
        // its close must never stand in for FIFO completion of that response.
        out.once("finish", wireDone);
        out.once("close", wireDone);
      }
    },
    start(): void {
      draining = true;
      for (const connection of connections) watch(connection);
      closeIdle();
    },
    closeIdle,
    force(): void {
      for (const connection of connections) connection.socket.destroy();
    },
  };
};
