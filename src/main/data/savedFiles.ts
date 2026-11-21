import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/** A thrown thing's message (shared/guards has the same; this module imports nothing of the app's,
 *  so jsonStore's crash test can run it in plain node). */
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// THE SAVED FILES ARE CHECKED ON LOAD (0.16.0, toward 1.0). Favorites, playlists and settings are
// the person's own work, and a file a sync tool, a disk or a hand edit broke must never be lost to
// the next save. So every read of a saved file goes through readSaved:
// - missing: a first run, nothing to keep;
// - unreadable (locked, no permission): this session never writes over it, and the log says so;
// - not JSON: the file is moved aside (name.unreadable-<date>.json, the newest few kept) before
//   anything writes, and a new one starts;
// - read: the owner checks its rows or values (data/savedChecks), and when anything is set aside,
//   the file as it was is copied aside first (name.as-found-<date>.json), so a typo in one row never
//   costs the row.
// And when the app's version changes, the files as the last version left them are copied into
// backups/<version>/ (the last few versions kept), before anything in this one writes.
// Electron-free, like jsonStore, so all of it runs in plain node tests. What it says goes to the
// diagnostics log through onSavedNotes (main wires it once the log exists; until then it waits).

export interface SavedNote {
  level: "info" | "warn" | "error";
  text: string;
}

let sink: ((note: SavedNote) => void) | null = null;
const waiting: SavedNote[] = [];

/** Where the notes go: the diagnostics log. Notes from before it existed arrive first. */
export function onSavedNotes(fn: (note: SavedNote) => void): void {
  sink = fn;
  for (const note of waiting.splice(0)) fn(note);
}

export function noteSaved(level: SavedNote["level"], text: string): void {
  if (sink) sink({ level, text });
  else waiting.push({ level, text });
}

/** How many copies of each kind are kept beside a file, and how many versions' backups. */
export const KEEP = 3;

const pad = (n: number): string => String(n).padStart(2, "0");
/** The local day, as the person who opens the folder reads it: 2026-11-11. */
const day = (now: Date): string =>
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
/** And the local time beside it, colons left out for Windows: 2026-11-11T09-30-05. */
const stamp = (now: Date): string =>
  `${day(now)}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

/** "favorites.unreadable-2026-11-11T09-30-05.json", beside the file. */
export function asideName(path: string, label: string, now: Date): string {
  const ext = extname(path);
  return join(dirname(path), `${basename(path, ext)}.${label}-${stamp(now)}${ext}`);
}

/** Only the newest KEEP copies of one kind stay. */
function pruneAside(path: string, label: string): void {
  const ext = extname(path);
  const prefix = `${basename(path, ext)}.${label}-`;
  const copies = readdirSync(dirname(path))
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
    .sort()
    .reverse();
  for (const old of copies.slice(KEEP)) rmSync(join(dirname(path), old), { force: true });
}

export type SavedRead =
  | { state: "missing" }
  | { state: "read"; parsed: unknown }
  /** Not JSON: already moved aside, so a write starts the file fresh. */
  | { state: "moved-aside" }
  /** Couldn't be read at all: nothing may write over it this session. */
  | { state: "unreadable" };

/** One read of a saved file, never a throw (see the top of this file). */
export function readSaved(path: string, now = new Date()): SavedRead {
  const name = basename(path);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    noteSaved(
      "error",
      `${name} couldn't be read (${errorMessage(err)}), so changes this session won't be saved to it`,
    );
    return { state: "unreadable" };
  }
  try {
    // a byte-order mark first (an editor's save, 0.16.0) is no reason to set the file aside
    return { state: "read", parsed: JSON.parse(text.replace(/^\uFEFF/, "")) as unknown };
  } catch {
    const aside = asideName(path, "unreadable", now);
    try {
      renameSync(path, aside);
      pruneAside(path, "unreadable");
    } catch (err) {
      noteSaved(
        "error",
        `${name} couldn't be read, nor moved aside (${errorMessage(err)}), so changes this session won't be saved to it`,
      );
      return { state: "unreadable" };
    }
    noteSaved(
      "warn",
      `${name} couldn't be read, so it was kept as ${basename(aside)} and a new one started`,
    );
    return { state: "moved-aside" };
  }
}

/** What a load set aside, said once, with the file as it was copied aside first. */
export function keepAsFound(path: string, setAside: readonly string[], now = new Date()): void {
  if (setAside.length === 0) return;
  const name = basename(path);
  let kept = "";
  try {
    const aside = asideName(path, "as-found", now);
    copyFileSync(path, aside);
    pruneAside(path, "as-found");
    kept = `; the file as it was is kept as ${basename(aside)}`;
  } catch {
    // the notes still go to the log: what was set aside is named there
  }
  for (const what of setAside) noteSaved("warn", `${name}: ${what}`);
  noteSaved("warn", `${name}: ${setAside.length} set aside${kept}`);
}

/** Whether version `a` is later than `b` ("1.2.0" > "1.1.9" > "1.1.9-rc.3" > "1.1.9-rc.2"); a
 *  name that isn't a version is never later. */
export function laterVersion(a: string, b: string): boolean {
  const parse = (v: string): { nums: number[]; pre: number[] | null } | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.?(\d+)?)?$/i.exec(v.trim());
    if (!m) return null;
    return {
      nums: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: v.includes("-") ? [Number(m[4] ?? 0)] : null,
    };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i];
  if (x.pre == null || y.pre == null) return x.pre == null && y.pre != null;
  return x.pre[0] > y.pre[0];
}

/**
 * The files as the last version left them, copied into backups/<when> from <version>/ the first time a
 * different version runs, before it writes anything; the last KEEP versions' backups kept, and the
 * newest from a release beside them (0.16.0: four release candidates in a row had pruned the copy
 * the release before them left). The version is remembered in backups/last-version. Never a throw:
 * a backup that fails is noted.
 */
export function keepVersionCopy(
  dir: string,
  version: string,
  files: readonly string[],
  now = new Date(),
): void {
  try {
    const backups = join(dir, "backups");
    const marker = join(backups, "last-version");
    const last = existsSync(marker) ? readFileSync(marker, "utf-8").trim() : null;
    if (last === version) return;
    const present = files.filter((f) => existsSync(join(dir, f)));
    mkdirSync(backups, { recursive: true });
    if (present.length > 0) {
      // named by when, then from which version ("an earlier version" for one from before the
      // backups), so the names sort in the order they were made, the newest last
      const into = join(backups, `${stamp(now)} from ${last ?? "an earlier version"}`);
      mkdirSync(into, { recursive: true });
      for (const f of present) copyFileSync(join(dir, f), join(into, f));
      const kept = readdirSync(backups)
        .filter((f) => statSync(join(backups, f)).isDirectory())
        .sort()
        .reverse();
      // a release's own version has no suffix; one from before the backups was a release
      const fromRelease = (name: string): boolean => {
        const from = / from (.+)$/.exec(name)?.[1] ?? "";
        return from === "an earlier version" || (from !== "" && !from.includes("-"));
      };
      const newestRelease = kept.find(fromRelease);
      // and the newest from a later version than this one (a rollback): its files are the only
      // copy of what that version wrote, and each launch of this one would prune it in turn
      const newestLater = kept.find((name) =>
        laterVersion(/ from (.+)$/.exec(name)?.[1] ?? "", version),
      );
      for (const old of kept.slice(KEEP))
        if (old !== newestRelease && old !== newestLater)
          rmSync(join(backups, old), { recursive: true, force: true });
      noteSaved(
        "info",
        `${present.join(", ")} from ${last ?? "an earlier version"} kept in backups/${basename(into)}`,
      );
    }
    writeFileSync(marker, version);
  } catch (err) {
    noteSaved(
      "error",
      `the saved files couldn't be backed up for this version (${errorMessage(err)})`,
    );
  }
}

/**
 * A SAVE THAT FAILED, SAID (0.16.0-rc.8, toward 1.0): a full disk or a folder that can't be
 * written was a console line only, and the session's changes were lost at quit with nothing
 * shown. Said in the log, and in the windows as a notice, once per file a session; `what` is the
 * reader's name for it ("your favorites").
 */
export function saveFailed(what: string, err: unknown): void {
  // read inline: this module imports only node (the write tests run it in a plain Node process)
  const code =
    typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "";
  const cause =
    code === "ENOSPC"
      ? " The disk is full."
      : code === "EACCES" || code === "EPERM" || code === "EROFS"
        ? " The folder can't be written to."
        : "";
  const text = `Couldn't save ${what}.${cause}`;
  noteSaved("error", `${text} (${errorMessage(err)})`);
  notice(text);
}

// the windows are main's to reach (app/runtime wires this); this module stays free of electron,
// since the write tests run it in a plain Node process
let notice: (text: string) => void = () => {};
export function onSaveFailedNotice(fn: (text: string) => void): void {
  notice = fn;
}
