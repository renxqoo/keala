/** Native tables may only bypass the kernel when no app policy needs it. */
import type { Application } from "./application.ts";
const protectedApps = new WeakSet<Application>();
export const requireRequestKernel = (app: Application): void => {
  protectedApps.add(app);
};
export const nativeRoutesAllowed = (app: Application): boolean => !protectedApps.has(app);
