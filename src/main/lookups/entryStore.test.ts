/**
 * The per-entry cache: entries in their own files behind a small index of summaries, the
 * LRU cap, a missing file forgotten, and the one-time migration from the single-file cache
 * that leaves the old file where it was.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntryStore } from "./entryStore";

type V = { dr: number; env: number[] };
let dir = "";
const store = (cap = 3, legacyFile?: string): EntryStore<V, { dr: number }> =>
  new EntryStore<V, { dr: number }>({
    dir: () => dir,
    name: "analysis",
    cap,
    summarize: (v) => ({ dr: v.dr }),
    legacyFile,
    isValue: (v): v is V => typeof (v as V)?.dr === "number" && Array.isArray((v as V)?.env),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "entrystore-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("entries and their summaries", () => {
  it("keeps each entry in its own file, readable by a fresh store from the index", () => {
    const a = store();
    a.set("artist|album|one|200", { dr: 9, env: [1, 2, 3] });
    a.set("artist|album|two|180", { dr: 7, env: [4] });
    a.flush();
    expect(readdirSync(join(dir, "analysis"))).toHaveLength(2);
    const b = store();
    expect(b.summary("artist|album|one|200")).toEqual({ dr: 9 });
    expect(b.get("artist|album|two|180")).toEqual({ dr: 7, env: [4] });
    expect(b.get("nobody")).toBeNull();
  });

  it("evicts the least recently accessed past the cap, file and all", () => {
    const s = store(2);
    s.set("a", { dr: 1, env: [] });
    s.set("b", { dr: 2, env: [] });
    s.get("a"); // a is now newer than b
    s.set("c", { dr: 3, env: [] });
    expect(s.has("b")).toBe(false);
    expect(s.has("a") && s.has("c")).toBe(true);
    expect(readdirSync(join(dir, "analysis"))).toHaveLength(2);
  });

  it("forgets an entry whose file went missing", () => {
    const s = store();
    s.set("a", { dr: 1, env: [] });
    for (const f of readdirSync(join(dir, "analysis"))) unlinkSync(join(dir, "analysis", f));
    expect(s.get("a")).toBeNull();
    expect(s.has("a")).toBe(false);
  });
});

describe("the migration from the single-file cache", () => {
  const legacy = (entries: [string, { v: unknown; at: number }][]): void =>
    writeFileSync(join(dir, "analysis.json"), JSON.stringify({ version: 1, entries }));

  it("reads every valid entry into its own file, keeps the most recent under the cap, and leaves the old file", () => {
    legacy([
      ["old", { v: { dr: 5, env: [1] }, at: 1 }],
      ["new", { v: { dr: 8, env: [2] }, at: 3 }],
      ["mid", { v: { dr: 6, env: [3] }, at: 2 }],
      ["bad", { v: { nope: true }, at: 4 }],
      ["miss", { v: null, at: 5 }],
    ]);
    const before = readFileSync(join(dir, "analysis.json"), "utf8");
    const s = store(2, "analysis.json");
    expect(s.summary("new")).toEqual({ dr: 8 });
    expect(s.get("mid")).toEqual({ dr: 6, env: [3] });
    expect(s.has("old") || s.has("bad") || s.has("miss")).toBe(false);
    expect(readFileSync(join(dir, "analysis.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "analysis-index.json"))).toBe(true);
  });

  it("happens once: with an index, the old file is not read again", () => {
    legacy([["a", { v: { dr: 5, env: [] }, at: 1 }]]);
    const first = store(3, "analysis.json");
    expect(first.has("a")).toBe(true);
    first.flush();
    legacy([["b", { v: { dr: 6, env: [] }, at: 2 }]]);
    const s = store(3, "analysis.json");
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
  });

  it("Clear removes the entries, the index and the old file", () => {
    legacy([["a", { v: { dr: 5, env: [] }, at: 1 }]]);
    const s = store(3, "analysis.json");
    expect(s.stats().entries).toBe(1);
    s.clear();
    expect(s.stats().entries).toBe(0);
    expect(existsSync(join(dir, "analysis.json")) || existsSync(join(dir, "analysis"))).toBe(false);
  });
});

describe("summaries remade from their files", () => {
  it("remakes only the stale summaries, in the background, and keeps them", async () => {
    const before = store(5);
    before.set("a", { dr: 9, env: [1, 2] });
    before.set("b", { dr: 7, env: [3] });
    before.flush();
    // a later build summarizes more: what the old summaries lack is remade from the files
    type S2 = { dr: number; n?: number };
    const later = (): EntryStore<V, S2> =>
      new EntryStore<V, S2>({
        dir: () => dir,
        name: "analysis",
        cap: 5,
        summarize: (v) => ({ dr: v.dr, n: v.env.length }),
      });
    const s = later();
    expect(s.peekSummary("a")).toEqual({ dr: 9 });
    const changed = await s.refreshSummaries((x) => x.n === undefined, 1);
    expect(changed).toBe(2);
    expect(s.peekSummary("a")).toEqual({ dr: 9, n: 2 });
    expect(s.peekSummary("b")).toEqual({ dr: 7, n: 1 });
    expect(await s.refreshSummaries((x) => x.n === undefined)).toBe(0);
    s.flush();
    expect(later().peekSummary("b")).toEqual({ dr: 7, n: 1 });
  });

  it("skips an entry whose file is gone, and joins a refresh already running", async () => {
    const a = store(5);
    a.set("a", { dr: 9, env: [1] });
    a.set("b", { dr: 8, env: [1, 1] });
    a.flush();
    unlinkSync(join(dir, "analysis", readdirSync(join(dir, "analysis"))[0]));
    const s = new EntryStore<V, { dr: number; n?: number }>({
      dir: () => dir,
      name: "analysis",
      cap: 5,
      summarize: (v) => ({ dr: v.dr, n: v.env.length }),
    });
    const one = s.refreshSummaries((x) => x.n === undefined);
    const two = s.refreshSummaries((x) => x.n === undefined);
    expect(two).toBe(one);
    expect(await one).toBe(1);
  });
});
