import type { ContextState } from "./context/state.ts";
import { getPathStart } from "../utils/url.ts";

/** Prefill routing and public URL views without a temporary match tuple. */
export const primeRequestUrl = (c: ContextState, url: string): string => {
  const start = getPathStart(url);
  const query = url.indexOf("?", start);
  const hash = url.indexOf("#", start);
  const sawQuery = query !== -1 && (hash === -1 || query < hash);
  const end = sawQuery ? query : hash;
  const rawPath = end === -1 ? url.slice(start) : url.slice(start, end);
  const path = rawPath.length === 0 ? "/" : rawPath;
  const view = sawQuery ? url.slice(start, hash === -1 ? url.length : hash) : path;
  c.pathValue = path;
  c.urlValue = sawQuery && rawPath.length === 0 ? "/" + view : view;
  return path;
};
