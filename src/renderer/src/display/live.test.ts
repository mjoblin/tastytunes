import { afterEach, describe, expect, it, vi } from "vitest";
import { followApp } from "./live";

/** The browser's EventSource, as far as the page's line uses it: each named event by hand. */
class FakeSource {
  static readonly CLOSED = 2;
  static made: FakeSource[] = [];
  readyState = 1;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly heard = new Map<string, Array<(e: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeSource.made.push(this);
  }

  addEventListener(type: string, cb: (e: MessageEvent<string>) => void): void {
    this.heard.set(type, [...(this.heard.get(type) ?? []), cb]);
  }

  close(): void {
    this.readyState = FakeSource.CLOSED;
  }

  emit(type: string, data: unknown): void {
    for (const cb of this.heard.get(type) ?? []) cb({ data: JSON.stringify(data) } as never);
  }
}

afterEach(() => {
  FakeSource.made = [];
  vi.unstubAllGlobals();
});

describe("the page's line to the app", () => {
  it("hands on the app's word that a track's analysis is stored, by its key", () => {
    vi.stubGlobal("EventSource", FakeSource);
    const measured: string[] = [];
    const reachable: boolean[] = [];
    const stop = followApp({
      snapshot: () => {},
      reachable: (heard) => reachable.push(heard),
      measured: (key) => measured.push(key),
    });
    const line = FakeSource.made[0];
    expect(line.url).toBe("/api/live");
    line.emit("measured", "band|record|song|200");
    expect(measured).toEqual(["band|record|song|200"]);
    // a word from the app is the app heard
    expect(reachable).toEqual([true]);
    stop();
  });

  it("takes the word without a listener for it", () => {
    vi.stubGlobal("EventSource", FakeSource);
    const stop = followApp({ snapshot: () => {}, reachable: () => {} });
    expect(() => FakeSource.made[0].emit("measured", "band|record|song|200")).not.toThrow();
    stop();
  });
});
