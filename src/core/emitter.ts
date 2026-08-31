/** Minimal event emitter (on/once/off/emit) — no classes, no allocations on emit paths without listeners. */

export type Listener = (...args: unknown[]) => void;

export interface Emitter {
  on(event: string, listener: Listener): () => void;
  once(event: string, listener: Listener): () => void;
  off(event: string, listener: Listener): void;
  emit(event: string, ...args: unknown[]): boolean;
  listenerCount(event: string): number;
}

export const createEmitter = (): Emitter => {
  const listeners = new Map<string, Listener[]>();

  const add = (event: string, listener: Listener): (() => void) => {
    const list = listeners.get(event);
    if (list === undefined) listeners.set(event, [listener]);
    else list.push(listener);
    return () => {
      const current = listeners.get(event);
      if (current === undefined) return;
      const index = current.indexOf(listener);
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
      const current = listeners.get(event);
      if (current === undefined) return;
      const index = current.findIndex(
        (registered) =>
          registered === listener || (registered as { listener?: Listener }).listener === listener,
      );
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
