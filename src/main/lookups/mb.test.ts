import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fetched } from "./mb";

// The gate keeps its queue and pause in module state, so each test takes a fresh copy, on a
// fake clock (the pace is seconds) and a fake fetch that logs when each request went out.
let mbFetch: (url: string, urgent?: boolean) => Promise<Fetched>;
let log: { url: string; at: number }[] = [];
let plan: (url: string) => number = () => 200;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  log = [];
  plan = () => 200;
  vi.stubGlobal("fetch", (url: string | URL) => {
    log.push({ url: String(url), at: Date.now() });
    const status = plan(String(url));
    return Promise.resolve(
      new Response(status === 200 ? "{}" : "no", {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  vi.resetModules();
  ({ mbFetch } = await import("./mb"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mbFetch", () => {
  it("serves an urgent request ahead of every waiting speculative one", async () => {
    const order: string[] = [];
    const speculative = ["a", "b", "c"].map((u) =>
      mbFetch(`http://mb/${u}`).then(() => order.push(u)),
    );
    const urgent = mbFetch("http://mb/u", true).then(() => order.push("u"));
    await vi.runAllTimersAsync();
    await Promise.all([...speculative, urgent]);
    expect(order.join("")).toBe("aubc");
  });

  it("pauses on a 503, retries the refused request once after the pause, and is back at the plain pace after the success", async () => {
    let first = true;
    plan = (u) => (u.endsWith("/x") && first ? ((first = false), 503) : 200);
    const x = mbFetch("http://mb/x");
    await vi.runAllTimersAsync();
    const got = await x;
    const xs = log.filter((l) => l.url.endsWith("/x"));
    const y = mbFetch("http://mb/y");
    await vi.runAllTimersAsync();
    await y;
    const ys = log.filter((l) => l.url.endsWith("/y"));
    expect(got.kind).toBe("ok");
    expect(xs).toHaveLength(2);
    const gap = xs[1].at - xs[0].at;
    expect(gap).toBeGreaterThanOrEqual(1900);
    expect(gap).toBeLessThan(3500);
    expect(ys).toHaveLength(1);
    expect(ys[0].at - xs[xs.length - 1].at).toBeLessThan(1700);
  });

  it("answers the oldest of more than eight waiting speculative requests dropped at once, unsent", async () => {
    void mbFetch("http://mb/hold");
    const waiting = Array.from({ length: 10 }, (_, i) => mbFetch(`http://mb/w${i}`));
    const soon = (p: Promise<Fetched>): Promise<Fetched | { kind: "timeout" }> =>
      Promise.race([
        p,
        new Promise<{ kind: "timeout" }>((r) => setTimeout(() => r({ kind: "timeout" }), 300)),
      ]);
    const firstSoon = soon(waiting[0]);
    const secondSoon = soon(waiting[1]);
    const thirdSoon = soon(waiting[2]);
    await vi.advanceTimersByTimeAsync(300);
    expect(await firstSoon).toEqual({ kind: "error", dropped: true });
    expect(await secondSoon).toEqual({ kind: "error", dropped: true });
    expect(await thirdSoon).toEqual({ kind: "timeout" });
    expect(log.some((l) => /\/w[01]$/.test(l.url))).toBe(false);
  });
});
