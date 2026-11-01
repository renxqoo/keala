/** Promise resolvers with Node 20 compatibility, without patching globals. */
export const promiseResolvers = <T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} => {
  if (typeof Promise.withResolvers === "function") return Promise.withResolvers<T>();
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
