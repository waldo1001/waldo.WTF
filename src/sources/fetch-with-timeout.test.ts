import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFetchWithTimeout } from "./fetch-with-timeout.js";
import type {
  FetchLike,
  FetchLikeResponse,
} from "./http-graph-client.js";

function hangingFetch(): {
  fetch: FetchLike;
  receivedSignal(): AbortSignal | undefined;
} {
  let received: AbortSignal | undefined;
  const fetch: FetchLike = (_url, init) => {
    received = init?.signal;
    return new Promise<FetchLikeResponse>((_resolve, reject) => {
      const sig = init?.signal;
      if (sig) {
        if (sig.aborted) {
          reject(sig.reason);
          return;
        }
        sig.addEventListener(
          "abort",
          () => {
            reject(sig.reason);
          },
          { once: true },
        );
      }
    });
  };
  return { fetch, receivedSignal: () => received };
}

function okResponse(): FetchLikeResponse {
  return {
    status: 200,
    headers: { get: (_n: string) => null },
    text: async () => "ok-body",
  };
}

describe("createFetchWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts at default timeout when caller passes no signal", async () => {
    const { fetch: inner, receivedSignal } = hangingFetch();
    const wrapped = createFetchWithTimeout({
      fetch: inner,
      defaultTimeoutMs: 1000,
    });

    const promise = wrapped("https://example.invalid/x");
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(999);
    let resolved: unknown = "still-pending";
    void promise.catch((e) => {
      resolved = e;
    });
    await Promise.resolve();
    expect(resolved).toBe("still-pending");

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
    expect(receivedSignal()?.aborted).toBe(true);
  });

  it("caller signal aborts before default timeout (caller's reason preserved)", async () => {
    const { fetch: inner } = hangingFetch();
    const wrapped = createFetchWithTimeout({
      fetch: inner,
      defaultTimeoutMs: 10_000,
    });

    const callerAc = new AbortController();
    const callerReason = new Error("caller-aborted");
    const promise = wrapped("https://example.invalid/x", {
      signal: callerAc.signal,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(100);
    callerAc.abort(callerReason);

    await expect(promise).rejects.toBe(callerReason);
  });

  it("default timeout aborts before caller signal (timeout's reason preserved)", async () => {
    const { fetch: inner } = hangingFetch();
    const wrapped = createFetchWithTimeout({
      fetch: inner,
      defaultTimeoutMs: 1000,
    });

    const callerAc = new AbortController();
    const promise = wrapped("https://example.invalid/x", {
      signal: callerAc.signal,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
    expect(callerAc.signal.aborted).toBe(false);
  });

  it("successful response within budget passes through unchanged", async () => {
    const inner: FetchLike = async () => okResponse();
    const wrapped = createFetchWithTimeout({
      fetch: inner,
      defaultTimeoutMs: 5000,
    });

    const res = await wrapped("https://example.invalid/x");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok-body");
  });

  it("rejects immediately when caller signal is already aborted", async () => {
    const { fetch: inner } = hangingFetch();
    const wrapped = createFetchWithTimeout({
      fetch: inner,
      defaultTimeoutMs: 5000,
    });

    const callerAc = new AbortController();
    const reason = new Error("pre-aborted");
    callerAc.abort(reason);

    await expect(
      wrapped("https://example.invalid/x", { signal: callerAc.signal }),
    ).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleanup: timer is cleared on successful response", async () => {
    const inner: FetchLike = async () => okResponse();
    const wrapped = createFetchWithTimeout({
      fetch: inner,
      defaultTimeoutMs: 5000,
    });

    expect(vi.getTimerCount()).toBe(0);
    await wrapped("https://example.invalid/x");
    expect(vi.getTimerCount()).toBe(0);
  });
});
