// Bounded, disk-persisted lookup caches (lyrics, artist context, …).
// Values are small JSON blobs, so a fixed entry cap — evicted least-recently-
// ACCESSED first — bounds each cache to a few MB; deliberately no size
// setting, just a visible size + Clear in Settings. Persisted misses (null)
// are definitive answers; a forced refresh overwrites them. Loads lazily on
// first use (userData may be overridden at startup), writes are debounced and
// atomic (tmp + rename), and a corrupt or version-mismatched file is
// discarded rather than trusted.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

const VERSION = 1;
const WRITE_DELAY_MS = 2000;

interface Entry<T> {
  v: T | null;
  at: number; // last-accessed (ms epoch) — the LRU key
}

const all: DiskCache<unknown>[] = [];

export class DiskCache<T> {
  private map: Map<string, Entry<T>> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly name: string,
    private readonly cap: number,
  ) {
    all.push(this);
  }

  private get file(): string {
    return join(app.getPath("userData"), "cache", `${this.name}.json`);
  }

  private load(): Map<string, Entry<T>> {
    if (this.map) return this.map;
    this.map = new Map();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as {
        version?: number;
        entries?: [string, Entry<T>][];
      };
      if (raw.version === VERSION && Array.isArray(raw.entries)) this.map = new Map(raw.entries);
    } catch {
      // first run, or unreadable — start empty
    }
    return this.map;
  }

  has(key: string): boolean {
    return this.load().has(key);
  }

  /** undefined = never cached; null = cached definitive miss. Reads bump LRU. */
  get(key: string): T | null | undefined {
    const entry = this.load().get(key);
    if (entry === undefined) return undefined;
    entry.at = Date.now();
    this.scheduleWrite();
    return entry.v;
  }

  set(key: string, value: T | null): void {
    const map = this.load();
    map.set(key, { v: value, at: Date.now() });
    while (map.size > this.cap) {
      let coldest: string | null = null;
      let coldestAt = Infinity;
      for (const [k, e] of map) {
        if (e.at < coldestAt) {
          coldestAt = e.at;
          coldest = k;
        }
      }
      if (coldest == null) break;
      map.delete(coldest);
    }
    this.scheduleWrite();
  }

  clear(): void {
    this.load().clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      rmSync(this.file, { force: true });
    } catch {
      // nothing on disk yet
    }
  }

  stats(): { entries: number; bytes: number } {
    // Report the last-flushed file size rather than forcing a synchronous
    // write on the main thread (Settings polls this); pending entries are
    // counted in `entries` and reach disk on the normal flush cadence.
    const entries = this.load().size;
    let bytes = 0;
    try {
      bytes = statSync(this.file).size;
    } catch {
      // not written yet
    }
    return { entries, bytes };
  }

  /** Write any pending changes now (stats, app quit). */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  private scheduleWrite(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, WRITE_DELAY_MS);
  }

  private write(): void {
    if (!this.map) return;
    try {
      mkdirSync(join(app.getPath("userData"), "cache"), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: VERSION, entries: [...this.map] }));
      renameSync(tmp, this.file);
    } catch {
      // disk persistence is best-effort; the in-memory cache still works
    }
  }
}

/** Combined stats across every lookup cache (the Settings row). */
export function lookupCacheStats(): { entries: number; bytes: number } {
  return all.reduce(
    (acc, c) => {
      const s = c.stats();
      return { entries: acc.entries + s.entries, bytes: acc.bytes + s.bytes };
    },
    { entries: 0, bytes: 0 },
  );
}

/** Wipe every lookup cache (memory + disk); returns the fresh stats. */
export function clearLookupCaches(): { entries: number; bytes: number } {
  for (const c of all) c.clear();
  return lookupCacheStats();
}

/** Flush pending writes (app quit). */
export function flushLookupCaches(): void {
  for (const c of all) c.flush();
}
