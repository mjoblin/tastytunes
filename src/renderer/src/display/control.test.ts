import { afterEach, describe, expect, it, vi } from "vitest";
import type { DisplayControl } from "@shared/displayControl";
import { appNow, hearControl, POST_MS, seekTo, steer, wasDone } from "./control";
import { sleepBadge, sleepCountdown } from "./sleepTimer";

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

const MIN = 60_000;
/** The app's clock as a line goes out. */
const APP = 1_700_000_000_000;
const LINE: DisplayControl = {
  state: "allowed",
  volume: null,
  next: null,
  queue: null,
  presets: null,
  playlists: null,
  wake: null,
  resume: null,
  standby: true,
  sleep: { action: "standby", endOfTrack: true, armed: { firesAt: APP + 10 * MIN } },
};

describe("the app's clock on a screen", () => {
  it("counts the sleep timer by the app's clock on a page whose own is minutes behind", () => {
    // the page's clock says seven minutes earlier than the app's as the line arrives
    const page = APP - 7 * MIN;
    hearControl({ ...LINE, now: APP }, page);
    expect(appNow(page)).toBe(APP);
    // ten minutes left by the app, never the seventeen the page's clock would say
    expect(sleepBadge(APP + 10 * MIN, appNow(page))).toBe("10m");
    expect(sleepCountdown(APP + 10 * MIN, appNow(page + 30_000))).toBe("9:30");
  });

  it("and on one whose own is minutes ahead, which never shows the timer run out early", () => {
    const page = APP + 12 * MIN;
    hearControl({ ...LINE, now: APP }, page);
    expect(sleepBadge(APP + 10 * MIN, appNow(page))).toBe("10m");
    expect(sleepCountdown(APP + 10 * MIN, appNow(page + 9 * MIN))).toBe("1:00");
  });

  it("keeps the last word for a line without the clock", () => {
    hearControl({ ...LINE, now: APP }, APP - 3 * MIN);
    hearControl({ ...LINE }, APP);
    expect(appNow(APP)).toBe(APP + 3 * MIN);
  });

  it("is moved by no line the page makes for itself (its own word that it is asking)", async () => {
    hearControl({ ...LINE, state: "ask", now: APP }, APP - 5 * MIN);
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ refused: "asking" }))),
    );
    await steer("next");
    expect(appNow(APP)).toBe(APP + 5 * MIN);
  });
});
