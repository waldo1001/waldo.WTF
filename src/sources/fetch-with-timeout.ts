import type { FetchLike } from "./http-graph-client.js";

export interface CreateFetchWithTimeoutOptions {
  readonly fetch: FetchLike;
  readonly defaultTimeoutMs: number;
}

export function createFetchWithTimeout(
  opts: CreateFetchWithTimeoutOptions,
): FetchLike {
  const { fetch: inner, defaultTimeoutMs } = opts;
  return async (input, init) => {
    const internal = new AbortController();
    const callerSignal = init?.signal;
    let onCallerAbort: (() => void) | undefined;

    const timer = setTimeout(() => {
      internal.abort(new DOMException("default timeout", "TimeoutError"));
    }, defaultTimeoutMs);

    if (callerSignal) {
      if (callerSignal.aborted) {
        clearTimeout(timer);
        internal.abort(callerSignal.reason);
      } else {
        onCallerAbort = () => internal.abort(callerSignal.reason);
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    try {
      return await inner(input, { ...init, signal: internal.signal });
    } finally {
      clearTimeout(timer);
      if (callerSignal && onCallerAbort) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    }
  };
}
