import { createWriteStream, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * THE EXPORTS FOLDER, ONE HOME FOR AN AGENT'S WRITES (0.17.0, export for an agent): no agent tool
 * writes a file but through here (lint export-writes), and nothing here writes outside the folder
 * the owner chose. A tool never names a path; names come from tags and are cleaned (no separators,
 * no leading dots, a length cap); each export is a new dated folder, nothing overwritten or
 * deleted; an export is held to a size cap, said when it is hit. Every file is written under a
 * ".part" name and renamed when whole, so a write cut short (a full disk, the app quitting) never
 * leaves a file that looks finished.
 */

/** The most one export may write (audio copies included): a hi-res album is gigabytes. */
export const EXPORT_CAP_BYTES = 2 * 1024 * 1024 * 1024;
/** Of the cap, what the records and the README may always use: pictures and audio copies stop
 *  short of it, so an export that fills up still ends with its record. */
export const RECORD_ROOM_BYTES = 32 * 1024 * 1024;
/** Of that room, what only the README and the final record (track.json or album.json) may use:
 *  analysis files that fill the records' room still leave the one file that says what is there. */
export const FINAL_ROOM_BYTES = 1024 * 1024;
/** A name's words at most (a tag, or an export's words before its date). */
const NAME_MAX = 80;
/** No byte of an audio copy for this long: the media server stopped sending (the analysis
 *  read's own rule, media/audioStream). */
export const COPY_STALL_MS = 20_000;

/** What a file name can't hold on one system or another (control characters are checked apart). */
const UNSAFE = '\\/:*?"<>|';

/** A name for a file or folder from a tag: no path separators or control characters, no leading
 *  dots, nothing reserved on Windows, at most `max` characters; never empty. */
export function safeName(raw: string | null | undefined, max = NAME_MAX): string {
  const cleaned = [...(raw ?? "")]
    .map((ch) => (ch.charCodeAt(0) < 32 || UNSAFE.includes(ch) ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+/, "")
    .slice(0, max)
    .replace(/[. ]+$/, "");
  const named = cleaned || "Untitled";
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(named) ? `${named}_` : named;
}

/** "The Cure - Songs of a Lost World - 08 I Can Never Say Goodbye (2026-11-22 2140)": the one
 *  place an export's folder is named, its words capped so the date always fits. */
export function exportDirName(parts: Array<string | null | undefined>, when: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}`;
  const words = parts.filter((p): p is string => !!p && p.trim() !== "").join(" - ");
  return `${safeName(words, NAME_MAX)} (${stamp})`;
}

/** The longest folder name exportDirName makes: its words and " (YYYY-MM-DD HHMM)". */
const DIR_NAME_MAX = NAME_MAX + 18;

export class ExportCapReached extends Error {}

/** What a file is to the cap: a picture or an audio copy ("media"), a record such as
 *  analysis.json ("record"), or the README and the record written last ("final"). */
export type WriteKind = "media" | "record" | "final";

/** Windows: what a rename meets while an antivirus, the search indexer or a sync client such as
 *  OneDrive holds the file just written. Such a rename is tried again after each of these waits,
 *  about two seconds in all; any other failure fails at once. */
const HELD = new Set(["EPERM", "EACCES", "EBUSY"]);
export const RENAME_WAITS_MS = [50, 150, 300, 500, 1000];

/** How long to wait before trying a rename again after its `tries`th failure, or null to give up. */
function waitAfter(e: unknown, tries: number): number | null {
  const code = (e as NodeJS.ErrnoException).code;
  return code && HELD.has(code) && tries <= RENAME_WAITS_MS.length
    ? RENAME_WAITS_MS[tries - 1]
    : null;
}

/** A pause on this thread: a write's rename is synchronous, as its write is. */
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A finished file to its own name, tried again while something holds it (HELD). */
export function renameWhenFree(
  from: string,
  to: string,
  move: (from: string, to: string) => void = renameSync,
  wait: (ms: number) => void = pause,
): void {
  for (let tries = 1; ; tries++) {
    try {
      move(from, to);
      return;
    } catch (e) {
      const ms = waitAfter(e, tries);
      if (ms == null) throw e;
      wait(ms);
    }
  }
}

/** renameWhenFree for an audio copy, waiting without holding up the app. */
export async function renameWhenFreeAsync(
  from: string,
  to: string,
  move: (from: string, to: string) => Promise<void> = rename,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      await move(from, to);
      return;
    } catch (e) {
      const ms = waitAfter(e, tries);
      if (ms == null) throw e;
      await wait(ms);
    }
  }
}

/** A path as an error message quotes it (an absolute one, or one in the home folder once that is
 *  "~"), with a rename's arrow before it. */
const QUOTED_PATH = /(\s*->\s*|\s)?'(~(?:[\\/][^']*)?|(?:[A-Za-z]:)?[\\/][^']*)'/g;

/** The home folder wherever a message names it whole: "/Users/ann", never the start of
 *  "/Users/anna". */
function homeFolder(home: string): RegExp {
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?=[\\\\/'\\s]|$)`, "g");
}

/**
 * A failure as left_out says it: the error's code and its plain reason, a path inside the export
 * by its place there and any other left out, so no record names a folder on the owner's computer
 * (a home folder is named for its account), redacted or not. The home folder is "~" before the
 * quoted paths go, so an apostrophe in its name can't end a quoted path part-way through it.
 */
export function reasonOf(e: unknown, dir: string, home: string = homedir()): string {
  const err = e instanceof Error ? (e as NodeJS.ErrnoException) : null;
  let said = (err ? err.message : String(e)).split(dir + sep).join("");
  if (home.length > 1) said = said.replace(homeFolder(home), "~");
  said = said.replace(QUOTED_PATH, "").trim();
  const code = err?.code;
  return code && !said.startsWith(code) ? `${code}: ${said}` : said;
}

/** The name a file is written under until it is whole. */
const partName = (full: string): string => `${full}.part`;

/** An audio copy that ended before its declared length, or went silent. */
export class CopyFailed extends Error {}

/** One export's folder: every write checked to land inside it and counted against the cap. */
export class ExportWriter {
  readonly dir: string;
  private total = 0;
  private readonly made: Array<{ path: string; bytes: number }> = [];

  /** `name` is exportDirName's, used as it is: one that isn't already a safe name is refused,
   *  never cleaned a second time (a second cut once took the date off a long name). */
  constructor(
    root: string,
    name: string,
    private readonly cap = EXPORT_CAP_BYTES,
  ) {
    if (safeName(name, DIR_NAME_MAX) !== name) throw new Error(`refused a folder name: ${name}`);
    const base = normalize(root);
    let dir = join(base, name);
    // a folder of that name already there (two exports in one minute): a new one beside it
    for (let n = 2; ; n++) {
      try {
        mkdirSync(dir, { recursive: false });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        dir = join(base, `${name} ${n}`);
      }
    }
    this.dir = dir;
  }

  /** What a write of `kind` may still use: media stops RECORD_ROOM_BYTES short of the cap, the
   *  other records FINAL_ROOM_BYTES short of it, and the final record may use it all (on a small
   *  cap, each room a share of it instead). No room is kept for pictures: an export writes them
   *  before its audio copies (main/export/exporter). */
  private room(kind: WriteKind): number {
    const reserve = Math.min(RECORD_ROOM_BYTES, Math.floor(this.cap / 4));
    const final = Math.min(FINAL_ROOM_BYTES, Math.floor(reserve / 4));
    const short = { final: 0, record: final, media: reserve }[kind];
    return this.cap - short - this.total;
  }

  get bytes(): number {
    return this.total;
  }

  /** What was written, each file by its path in the export and its size. */
  files(): Array<{ path: string; bytes: number }> {
    return [...this.made];
  }

  private inside(rel: string): string {
    const full = normalize(join(this.dir, rel));
    if (!full.startsWith(this.dir + sep))
      throw new Error(`refused a path outside the export: ${rel}`);
    mkdirSync(join(full, ".."), { recursive: true });
    return full;
  }

  /** A file: a picture is "media", analysis.json and the lyrics "record", the README and the
   *  record written last "final". */
  write(rel: string, data: string | Uint8Array, kind: WriteKind = "media"): void {
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (size > this.room(kind)) throw new ExportCapReached(rel);
    const full = this.inside(rel);
    const part = partName(full);
    try {
      writeFileSync(part, data);
      renameWhenFree(part, full);
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
    this.total += size;
    this.made.push({ path: rel, bytes: size });
  }

  /** A stream (an audio copy) into the folder, stopped short of the records' room. A body that
   *  goes silent for COPY_STALL_MS, or ends before the length it declared, is a failed copy:
   *  what was written goes, and nothing incomplete is ever kept (nor, until it is whole, under
   *  its own name). */
  async copy(
    rel: string,
    body: ReadableStream<Uint8Array>,
    expected?: number,
    stallMs = COPY_STALL_MS,
  ): Promise<void> {
    const cap = this.room("media");
    if (expected != null && expected > cap) {
      void body.cancel();
      throw new ExportCapReached(rel);
    }
    const full = this.inside(rel);
    const part = partName(full);
    let seen = 0;
    let stall: ReturnType<typeof setTimeout> | undefined;
    const counted = Readable.fromWeb(body as never);
    const quiet = (): void => {
      clearTimeout(stall);
      stall = setTimeout(
        () => counted.destroy(new CopyFailed("the media server stopped sending")),
        stallMs,
      );
    };
    counted.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      quiet();
      if (seen > cap) counted.destroy(new ExportCapReached(rel));
    });
    quiet();
    try {
      await pipeline(counted, createWriteStream(part));
      if (expected != null && seen < expected)
        throw new CopyFailed(`the media server sent ${seen} of ${expected} bytes`);
      await renameWhenFreeAsync(part, full);
    } catch (e) {
      // the part written is this export's own and incomplete: it goes, and the reply says so
      rmSync(part, { force: true });
      throw e;
    } finally {
      clearTimeout(stall);
    }
    this.total += seen;
    this.made.push({ path: rel, bytes: seen });
  }
}
