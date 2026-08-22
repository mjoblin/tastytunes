import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The one JSON-persistence layer for the local data files (favorites,
// playlists, recents, settings, the media index). Deliberately electron-free
// so it can be crash-tested in plain node — paths arrive as thunks because
// app.getPath isn't ready at import time.

/**
 * Write-then-RENAME, never write-in-place.
 *
 * A plain writeFileSync over the live file truncates it first — a crash (or
 * power loss) mid-write leaves favorites/playlists/history as half a JSON
 * file, and there is no recovery path for user data. Writing a sibling temp
 * file and renaming it into place is atomic on the same filesystem: the live
 * file is always either the old complete content or the new complete content.
 * (No fsync — the threat model here is process death mid-write, which rename
 * fully covers; true power-loss durability would need fsync on file AND
 * directory for a marginal gain these files don't warrant.)
 */
export function atomicWriteFileSync(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* never existed, or the rename already consumed it */
    }
    throw err;
  }
}

/**
 * A cached, atomically-persisted JSON file — the load/save half that
 * favorites.ts and playlists.ts used to hand-roll identically. `load` turns
 * whatever was parsed (or undefined, for a missing/corrupt file) into a valid
 * T; domain logic (sorting, bounds, healing) stays in the owning store, ON TOP
 * of get/set. Stores whose load is itself domain-heavy (recents' upgrade +
 * collapse pass, settings' nested-default backfill) keep their own flow and
 * take just atomicWriteFileSync.
 */
export function jsonFileStore<T>(opts: {
  /** Lazy: app.getPath('userData') isn't available at import time. */
  pathOf(): string;
  /** For the persist-failure log line. */
  scope: string;
  load(parsed: unknown): T;
}): { get(): T; set(next: T): T } {
  let cached: T | null = null;
  return {
    get() {
      if (cached !== null) return cached;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(opts.pathOf(), "utf-8"));
      } catch {
        parsed = undefined;
      }
      cached = opts.load(parsed);
      return cached;
    },
    set(next: T) {
      cached = next;
      try {
        atomicWriteFileSync(opts.pathOf(), JSON.stringify(next));
      } catch (err) {
        console.error(`failed to persist ${opts.scope}`, err);
      }
      return next;
    },
  };
}
