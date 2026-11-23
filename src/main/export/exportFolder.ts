import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * THE EXPORTS FOLDER, ONE HOME FOR AN AGENT'S WRITES (0.17.0, export for an agent): no agent tool
 * writes a file but through here (lint export-writes), and nothing here writes outside the folder
 * the owner chose. A tool never names a path; names come from tags and are cleaned (no separators,
 * no leading dots, a length cap); each export is a new dated folder, nothing overwritten or
 * deleted; an export is held to a size cap, said when it is hit.
 */

/** The most one export may write (audio copies included): a hi-res album is gigabytes. */
export const EXPORT_CAP_BYTES = 2 * 1024 * 1024 * 1024;

/** A name for a file or folder from a tag: no path separators or control characters, no leading
 *  dots, nothing reserved on Windows, at most 80 characters; never empty. */
/** What a file name can't hold on one system or another (control characters are checked apart). */
const UNSAFE = '\\/:*?"<>|';

export function safeName(raw: string | null | undefined): string {
  const cleaned = [...(raw ?? "")]
    .map((ch) => (ch.charCodeAt(0) < 32 || UNSAFE.includes(ch) ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+/, "")
    .slice(0, 80)
    .replace(/[. ]+$/, "");
  const named = cleaned || "Untitled";
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(named) ? `${named}_` : named;
}

/** "The Cure - Songs of a Lost World - 08 I Can Never Say Goodbye (2026-11-22 2140)". */
export function exportDirName(parts: Array<string | null | undefined>, when: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}`;
  const named = parts.filter((p): p is string => !!p && p.trim() !== "").map(safeName);
  return `${named.join(" - ").slice(0, 160)} (${stamp})`;
}

export class ExportCapReached extends Error {}

/** One export's folder: every write checked to land inside it and counted against the cap. */
export class ExportWriter {
  readonly dir: string;
  private total = 0;
  private readonly made: Array<{ path: string; bytes: number }> = [];

  constructor(
    root: string,
    name: string,
    private readonly cap = EXPORT_CAP_BYTES,
  ) {
    const base = normalize(root);
    let dir = join(base, safeName(name));
    // a folder of that name already there (two exports in one minute): a new one beside it
    for (let n = 2; ; n++) {
      try {
        mkdirSync(dir, { recursive: false });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        dir = join(base, `${safeName(name)} ${n}`);
      }
    }
    this.dir = dir;
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

  write(rel: string, data: string | Uint8Array): void {
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (this.total + size > this.cap) throw new ExportCapReached(rel);
    writeFileSync(this.inside(rel), data);
    this.total += size;
    this.made.push({ path: rel, bytes: size });
  }

  /** A stream (an audio copy) into the folder, stopped at the cap. */
  async copy(rel: string, body: ReadableStream<Uint8Array>, expected?: number): Promise<void> {
    if (expected != null && this.total + expected > this.cap) {
      void body.cancel();
      throw new ExportCapReached(rel);
    }
    const full = this.inside(rel);
    let seen = 0;
    const cap = this.cap - this.total;
    const counted = Readable.fromWeb(body as never).on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > cap) counted.destroy(new ExportCapReached(rel));
    });
    try {
      await pipeline(counted, createWriteStream(full));
    } catch (e) {
      // the part written is this export's own and incomplete: it goes, and the reply says so
      rmSync(full, { force: true });
      throw e;
    }
    this.total += seen;
    this.made.push({ path: rel, bytes: seen });
  }
}
