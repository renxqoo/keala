export const promiseResolvers = <T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
