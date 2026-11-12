import { chmodSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { keepAsFound, readSaved } from "./savedFiles";

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
 * directory for a marginal gain these files don't warrant.) A `mode` (the secrets store's 0600)
 * applies to the temporary file before any data reaches it.
 */
export function atomicWriteFileSync(path: string, data: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    // a mode given holds from the first byte (0.15.0, the secrets store): a temporary file a crash
    // left behind would keep its own mode, so it goes first; the chmod makes the mode exact
    // whatever the umask took
    if (mode != null) rmSync(tmp, { force: true });
    writeFileSync(tmp, data, mode != null ? { mode } : undefined);
    if (mode != null) chmodSync(tmp, mode);
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
 * whatever was parsed (or undefined, for a missing file or one moved aside) into
 * a valid T, naming in `setAside` whatever it left out (data/savedChecks); domain
 * logic (sorting, bounds, healing) stays in the owning store, ON TOP of get/set.
 * The read goes through data/savedFiles (0.16.0): a file that isn't JSON is moved
 * aside before anything writes, one that can't be read is never written over this
 * session, and when a load sets anything aside the file as it was is copied aside
 * first. Stores whose load is itself domain-heavy (recents' upgrade + collapse
 * pass, settings' nested-default backfill) keep their own flow and take just
 * atomicWriteFileSync (settings reads through savedFiles too).
 */
export function jsonFileStore<T>(opts: {
  /** Lazy: app.getPath('userData') isn't available at import time. */
  pathOf(): string;
  /** For the persist-failure log line. */
  scope: string;
  load(parsed: unknown, setAside: string[]): T;
}): { get(): T; set(next: T): T } {
  let cached: T | null = null;
  // a file that couldn't be read is never written over this session (data/savedFiles)
  let unreadable = false;
  return {
    get() {
      if (cached !== null) return cached;
      const path = opts.pathOf();
      const read = readSaved(path);
      unreadable = read.state === "unreadable";
      const setAside: string[] = [];
      cached = opts.load(read.state === "read" ? read.parsed : undefined, setAside);
      keepAsFound(path, setAside);
      return cached;
    },
    set(next: T) {
      cached = next;
      if (unreadable) return next;
      try {
        atomicWriteFileSync(opts.pathOf(), JSON.stringify(next));
      } catch (err) {
        console.error(`failed to persist ${opts.scope}`, err);
      }
      return next;
    },
  };
}
