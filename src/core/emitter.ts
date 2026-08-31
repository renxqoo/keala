/**
 * Minimal event emitter (on/once/off/emit) — no classes, no allocations on
 * emit paths without listeners. Duplicate-removal follows Node's
 * EventEmitter order: off() removes the MOST RECENTLY registered matching
 * instance, and non-function listeners are refused at subscription time
 * (Node's ERR_INVALID_ARG_TYPE contract) instead of exploding at emit.
 */

export type Listener = (...args: unknown[]) => void;

export interface Emitter {
  on(event: string, listener: Listener): () => void;
  once(event: string, listener: Listener): () => void;
  off(event: string, listener: Listener): void;
  emit(event: string, ...args: unknown[]): boolean;
  listenerCount(event: string): number;
}

const assertListener = (listener: Listener): void => {
  if (typeof listener !== "function") {
    throw new TypeError("event listeners must be functions");
  }
};

/** Index of the LAST registration matching `listener` (a once() wrapper via
 *  its `.listener` alias), searching backwards like Node's removeListener. */
const lastIndexOf = (list: readonly Listener[], listener: Listener): number => {
  for (let i = list.length - 1; i >= 0; i--) {
    const registered = list[i] as Listener;
    if (registered === listener || (registered as { listener?: Listener }).listener === listener) {
      return i;
    }
  }
  return -1;
};

export const createEmitter = (): Emitter => {
  const listeners = new Map<string, Listener[]>();

  const add = (event: string, listener: Listener): (() => void) => {
    assertListener(listener);
    const list = listeners.get(event);
    if (list === undefined) listeners.set(event, [listener]);
    else list.push(listener);
    return () => {
      const current = listeners.get(event);
      if (current === undefined) return;
      // Backward too: the dispose belongs to ONE add() call — with duplicates
      // registered, unhooking the newest match is the faithful proxy.
      const index = lastIndexOf(current, listener);
      if (index !== -1) current.splice(index, 1);
    };
  };

  return {
    on: (event, listener) => add(event, listener),
    once(event, listener) {
      // The wrapper records the ORIGINAL listener (the Node EventEmitter
      // `.listener` contract) so off(event, original) removes it — a once()
      // registration must be removable the same way an on() one is.
      const wrapper: Listener & { listener?: Listener } = (...args: unknown[]) => {
        dispose();
        listener(...args);
      };
      wrapper.listener = listener;
      const dispose = add(event, wrapper);
      return dispose;
    },
    off(event, listener) {
      assertListener(listener);
      const current = listeners.get(event);
      if (current === undefined) return;
      const index = lastIndexOf(current, listener);
      if (index !== -1) current.splice(index, 1);
    },
    emit(event, ...args) {
      const list = listeners.get(event);
      if (list === undefined || list.length === 0) return false;
      for (const listener of list.slice()) listener(...args);
      return true;
    },
    listenerCount: (event) => listeners.get(event)?.length ?? 0,
  };
};
