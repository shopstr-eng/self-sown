/**
 * Builds a Promise from an async executor body.
 *
 * `new Promise(async (resolve, reject) => ...)` is an anti-pattern: an error
 * thrown inside the executor after its first `await` escapes as an unhandled
 * rejection instead of rejecting the promise, silently skipping the caller's
 * error handling. This helper keeps the resolve/reject closure style (needed
 * when nested callbacks settle the promise) but routes any escaped rejection
 * to reject().
 */
export function promiseFromAsync<T>(
  body: (
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void
  ) => Promise<void>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    void body(resolve, reject).catch(reject);
  });
}
