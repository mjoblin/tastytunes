// A bounded cache that keeps EACH ENTRY IN ITS OWN FILE (0.11.0 sweep), for values too big
// to rewrite together: the audio analyses, whose one JSON file had grown to 14 MB and was
// parsed whole on the main thread at the first read, then rewritten whole two seconds after
// every read (a read bumps the LRU) and every write. Here a small index holds each key's
// summary (what the many-key reads need, so they touch no entry file) and its last access;
// an entry's file is read when that entry is asked for, and written when it is set.
// Least-recently-accessed entries are evicted past the cap. The index write is debounced
// and atomic (tmp + rename); an entry file is written atomically on its own.
//
// MIGRATION: the first load with no index reads the legacy single-file cache, if there is
// one, into entry files and an index. The legacy file is left exactly where it was, so a
// build from before keeps reading it; Clear removes it with the rest.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const VERSION = 1;
const WRITE_DELAY_MS = 2000;

interface IndexEntry<S> {
  /** The entry's summary, made by the store's summarize when it was set. */
  s: S;
  /** Last accessed (ms epoch), for the migration and a reader; the index's order is the LRU order. */
  at: number;
  /** The entry file's size. */
  bytes: number;
}

export interface EntryStoreOptions<T, S> {
  /** The cache directory (resolved lazily: userData may be overridden at startup). */
  dir: () => string;
  /** The store's name: the entry folder and the index file are named for it. */
  name: string;
  cap: number;
  summarize: (value: T) => S;
  /** The legacy single-file cache to migrate from (a DiskCache file: {version, entries}). */
  legacyFile?: string;
  /** A legacy entry's shape check (an entry that fails it is not migrated). */
  isValue?: (v: unknown) => v is T;
}

export class EntryStore<T, S> {
  private index: Map<string, IndexEntry<S>> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: EntryStoreOptions<T, S>) {}

  private get folder(): string {
    return join(this.o.dir(), this.o.name);
  }

  private get indexFile(): string {
    return join(this.o.dir(), `${this.o.name}-index.json`);
  }

  private fileOf(key: string): string {
    return join(this.folder, `${createHash("sha1").update(key).digest("hex")}.json`);
  }

  private load(): Map<string, IndexEntry<S>> {
    if (this.index) return this.index;
    this.index = new Map();
    try {
      const raw = JSON.parse(readFileSync(this.indexFile, "utf8")) as {
        version?: number;
        entries?: [string, IndexEntry<S>][];
      };
      if (raw.version === VERSION && Array.isArray(raw.entries)) this.index = new Map(raw.entries);
      return this.index;
    } catch {
      // no index yet: a first run, or the first run after the single-file cache
    }
    this.migrate();
    return this.index;
  }

  /** The legacy single file, read once into entry files and an index; the file stays. */
  private migrate(): void {
    const { legacyFile, isValue } = this.o;
    if (!legacyFile || !this.index) return;
    let raw: { version?: number; entries?: [string, { v: unknown; at: number }][] };
    try {
      raw = JSON.parse(readFileSync(join(this.o.dir(), legacyFile), "utf8")) as typeof raw;
    } catch {
      return;
    }
    if (raw.version !== 1 || !Array.isArray(raw.entries)) return;
    // the valid entries, oldest access first (the index's order is the LRU order), keeping the
    // most recent under the cap, which is what the old cache would have kept
    const valid = raw.entries
      .filter(
        ([key, e]) =>
          typeof key === "string" && e != null && e.v != null && (!isValue || isValue(e.v)),
      )
      .sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
    for (const [key, e] of valid.slice(-this.o.cap)) {
      const bytes = this.writeEntry(key, e.v as T);
      if (bytes == null) continue;
      this.index.set(key, { s: this.o.summarize(e.v as T), at: e.at ?? Date.now(), bytes });
    }
    this.writeIndex();
  }

  /** A use: the entry moves to the young end of the index (whose order is the LRU order). */
  private use(key: string, entry: IndexEntry<S>): void {
    const index = this.load();
    index.delete(key);
    entry.at = Date.now();
    index.set(key, entry);
    this.scheduleWrite();
  }

  private writeEntry(key: string, value: T): number | null {
    try {
      mkdirSync(this.folder, { recursive: true });
      const file = this.fileOf(key);
      const text = JSON.stringify({ key, v: value });
      writeFileSync(`${file}.tmp`, text);
      renameSync(`${file}.tmp`, file);
      return Buffer.byteLength(text);
    } catch {
      return null;
    }
  }

  has(key: string): boolean {
    return this.load().has(key);
  }

  /** The entry, read from its file; null when there is none (or its file is gone). Bumps the LRU. */
  get(key: string): T | null {
    const entry = this.load().get(key);
    if (!entry) return null;
    try {
      const raw = JSON.parse(readFileSync(this.fileOf(key), "utf8")) as { key?: string; v?: T };
      if (raw.key !== key || raw.v == null) throw new Error("not this entry");
      this.use(key, entry);
      return raw.v;
    } catch {
      // the file went missing or is not this entry's: forget it
      this.load().delete(key);
      this.scheduleWrite();
      return null;
    }
  }

  /** The entry's summary, from the index alone (no file read). A use, like get: a row that
   *  shows an entry's numbers keeps it as alive as a picture that draws it. */
  summary(key: string): S | undefined {
    const entry = this.load().get(key);
    if (!entry) return undefined;
    this.use(key, entry);
    return entry.s;
  }

  set(key: string, value: T): void {
    const index = this.load();
    const bytes = this.writeEntry(key, value);
    if (bytes == null) return;
    index.delete(key);
    index.set(key, { s: this.o.summarize(value), at: Date.now(), bytes });
    // the index's order is the LRU order: the first key is the least recently used
    while (index.size > this.o.cap) {
      const coldest = index.keys().next();
      if (coldest.done) break;
      index.delete(coldest.value);
      try {
        unlinkSync(this.fileOf(coldest.value));
      } catch {
        // already gone
      }
    }
    this.scheduleWrite();
  }

  /** Every entry, the legacy file too (Settings' Clear). */
  clear(): void {
    this.index = new Map();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const f of [
      this.folder,
      this.indexFile,
      ...(this.o.legacyFile ? [join(this.o.dir(), this.o.legacyFile)] : []),
    ]) {
      try {
        rmSync(f, { recursive: true, force: true });
      } catch {
        // nothing there
      }
    }
  }

  stats(): { entries: number; bytes: number } {
    const index = this.load();
    let bytes = 0;
    for (const e of index.values()) bytes += e.bytes;
    try {
      bytes += statSync(this.indexFile).size;
    } catch {
      // not written yet
    }
    return { entries: index.size, bytes };
  }

  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.writeIndex();
  }

  private scheduleWrite(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeIndex();
    }, WRITE_DELAY_MS);
  }

  private writeIndex(): void {
    if (!this.index) return;
    try {
      mkdirSync(this.o.dir(), { recursive: true });
      const tmp = `${this.indexFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: VERSION, entries: [...this.index] }));
      renameSync(tmp, this.indexFile);
    } catch {
      // best-effort, like every cache: the store still works in memory and on its files
    }
  }
}
