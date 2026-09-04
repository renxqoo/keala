/**
 * One 'close' listener per socket, fanning out to the requests in flight
 * on it — the Node adapter's wire-truth + disconnect bridge (extracted
 * from node.ts for the 500-line budget).
 */

import type { Socket } from "node:net";

interface SocketCloseFanout {
  pending: Set<() => void>;
  handler: () => void;
}

const socketCloses = new WeakMap<Socket, SocketCloseFanout>();

export interface SocketCloseRegistration {
  readonly socket: Socket;
  readonly entry: SocketCloseFanout;
  readonly onDone: () => void;
}

/** Subscribe `onDone` to the socket's close; ONE listener per socket total. */
export const registerSocketClose = (
  socket: Socket,
  onDone: () => void,
): SocketCloseRegistration => {
  let entry = socketCloses.get(socket);
  if (entry === undefined) {
    const fanout: SocketCloseFanout = { pending: new Set(), handler: () => undefined };
    fanout.handler = (): void => {
      // Copy: each fired callback unregisters itself from `pending`.
      for (const fn of Array.from(fanout.pending)) fn();
    };
    entry = fanout;
    socketCloses.set(socket, fanout);
    socket.on("close", fanout.handler);
  }
  entry.pending.add(onDone);
  return { socket, entry, onDone };
};

/** Detach one subscription; the shared listener leaves with the last one. */
export const unregisterSocketClose = (reg: SocketCloseRegistration): void => {
  reg.entry.pending.delete(reg.onDone);
  if (reg.entry.pending.size === 0) {
    reg.socket.removeListener("close", reg.entry.handler);
    socketCloses.delete(reg.socket);
  }
};
