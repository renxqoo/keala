/**
 * Minimal functional event emitter backing `app.on("error", ...)`.
 */

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

  const off = (event: string, listener: Listener): void => {
    const list = listeners.get(event);
    if (list === undefined) return;
    const index = list.indexOf(listener);
    if (index !== -1) list.splice(index, 1);
    if (list.length === 0) listeners.delete(event);
  };

  return {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      if (list.length === 0) listeners.set(event, list);
      list.push(listener);
      return () => off(event, listener);
    },
    once(event, listener) {
      const wrapped: Listener = (...args: unknown[]) => {
        off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    },
    off,
    emit(event, ...args) {
      const list = listeners.get(event);
      if (list === undefined || list.length === 0) return false;
      for (const listener of list.slice()) {
        (listener as (...rest: unknown[]) => void)(...args);
      }
      return true;
    },
    listenerCount(event) {
      return listeners.get(event)?.length ?? 0;
    },
  };
};
