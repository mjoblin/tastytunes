import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiskCache } from "./diskCache";

const fileOf = (name: string): string => join(app.getPath("userData"), "cache", `${name}.json`);

describe("a disk cache's reads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never write the file on their own, and the quit's flush keeps their bump", () => {
    const cache = new DiskCache<string>("readsdontwrite", 10);
    cache.set("a", "one");
    cache.flush();
    const file = fileOf("readsdontwrite");
    expect(existsSync(file)).toBe(true);
    const before = (
      JSON.parse(readFileSync(file, "utf8")) as { entries: [string, { at: number }][] }
    ).entries[0][1].at;
    rmSync(file);

    vi.setSystemTime(Date.now() + 60_000);
    expect(cache.get("a")).toBe("one");
    vi.advanceTimersByTime(10_000);
    // a read alone wrote nothing
    expect(existsSync(file)).toBe(false);

    cache.flush();
    const after = (
      JSON.parse(readFileSync(file, "utf8")) as { entries: [string, { at: number }][] }
    ).entries[0][1].at;
    expect(after).toBeGreaterThan(before);
  });

  it("let a later write carry the bump", () => {
    const cache = new DiskCache<string>("bumpcarried", 10);
    cache.set("a", "one");
    cache.flush();
    vi.setSystemTime(Date.now() + 60_000);
    const readAt = Date.now();
    cache.get("a");
    cache.set("b", "two");
    vi.advanceTimersByTime(10_000);
    const entries = new Map(
      (
        JSON.parse(readFileSync(fileOf("bumpcarried"), "utf8")) as {
          entries: [string, { at: number }][];
        }
      ).entries,
    );
    expect(entries.get("a")?.at).toBe(readAt);
    expect(entries.has("b")).toBe(true);
  });

  it("flush nothing when nothing changed", () => {
    const cache = new DiskCache<string>("nothingchanged", 10);
    cache.set("a", "one");
    cache.flush();
    rmSync(fileOf("nothingchanged"));
    cache.flush();
    expect(existsSync(fileOf("nothingchanged"))).toBe(false);
  });
});
