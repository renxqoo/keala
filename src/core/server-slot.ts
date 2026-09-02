/**
 * The running-server registry (R4.6): both adapters register their handle
 * here so `app.close()` can reach socket truth without asking which runtime
 * it is on. A WeakMap — the handle lives exactly as long as the app.
 */

import type { StoppableHandle } from "./lifecycle.ts";

const servers = new WeakMap<object, StoppableHandle>();

export const attachServer = (app: object, handle: StoppableHandle): void => {
  servers.set(app, handle);
};

export const serverOf = (app: object): StoppableHandle | undefined => servers.get(app);
