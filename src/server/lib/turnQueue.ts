export function waitForAbort<Result>(promise: Promise<Result>, signal?: AbortSignal): Promise<Result> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Coding task interrupted.", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Coding task interrupted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class TurnQueue {
  private readonly pending = new Map<string, Promise<void>>();
  private disposed = false;

  dispose() {
    this.disposed = true;
  }

  run<Result>(key: string, signal: AbortSignal | undefined, operation: () => Promise<Result>) {
    const result = (this.pending.get(key) ?? Promise.resolve()).then(() => {
      if (this.disposed) throw new Error("Coding agent was disposed.");
      if (signal?.aborted) throw new DOMException("Coding task interrupted.", "AbortError");
      return operation();
    });
    const settled = result.then(() => {}, () => {});
    this.pending.set(key, settled);
    void settled.then(() => {
      if (this.pending.get(key) === settled) this.pending.delete(key);
    });
    return waitForAbort(result, signal);
  }
}
