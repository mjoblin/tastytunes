import { afterEach, describe, expect, it, vi } from "vitest";
import { POST_MS, seekTo, steer, wasDone } from "./control";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A fetch that never answers, rejecting only when its signal ends it, as a browser's does. */
const unanswered = (): void => {
  vi.stubGlobal(
    "fetch",
    (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
};

/** The browser's own timeout, on the test's clock. */
const onTestClock = (): void => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    return c.signal;
  });
};

describe("a control post", () => {
  it("gives up after POST_MS, answering as a post the app never got", async () => {
    onTestClock();
    unanswered();
    let answer: unknown = "pending";
    void steer("next").then((a) => (answer = a));
    await vi.advanceTimersByTimeAsync(POST_MS - 1);
    expect(answer).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBeNull();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(POST_MS);
  });

  it("a seek that timed out is not done", async () => {
    onTestClock();
    unanswered();
    const answer = seekTo(42);
    await vi.advanceTimersByTimeAsync(POST_MS);
    expect(await answer).toBeNull();
  });

  it("hands back the app's answer when it comes in time", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ done: true }))));
    expect(await steer("toggle")).toEqual({ done: true });
  });

  it("was done only when the app says so: a refusal or no answer is not", () => {
    expect(wasDone({ done: true })).toBe(true);
    expect(wasDone({ refused: "nothing" })).toBe(false);
    expect(wasDone({ refused: "busy" })).toBe(false);
    expect(wasDone(null)).toBe(false);
  });
});
