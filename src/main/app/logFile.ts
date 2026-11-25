import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry } from "@shared/model";

// A LOG THAT SURVIVES A QUIT (0.16.0 hardening). The diagnostics drawer's lines are also written
// to a file, so what a streamer we don't have sent (the wire's check names it) can reach us when
// someone attaches the file to an email. Two files, the current one and the one before it, each
// kept near a megabyte. Local only: nothing reads or sends it but the person who opens it, and a
// token or key never lands in it (redact). Written a line at a time, synchronously, so the lines
// before a crash are on disk, and with no file held open, so rotating works on Windows too.

export const LOG_NAME = "tastytunes.log";
export const PREVIOUS_LOG_NAME = "tastytunes.1.log";

/** A token, key or password in a line, hidden: "Bearer x", "token=x", "api_key: x" and the like. */
export function redact(text: string): string {
  return text
    .replace(/\b(bearer\s+)[^\s"',;)]+/gi, "$1[hidden]")
    .replace(
      /\b(token|api_?key|apikey|sk|session_?key|secret|password)(["']?\s*[=:]\s*["']?)[^\s"'&,;)]+/gi,
      "$1$2[hidden]",
    );
}

export const logLine = (e: LogEntry): string =>
  `${new Date(e.at).toISOString()} ${e.level.padEnd(5)} [${e.scope}] ${redact(e.text)}\n`;

export class LogFile {
  readonly path: string;
  private readonly previous: string;
  private size = -1; // unread until the first write
  private broken = false;

  constructor(
    readonly dir: string,
    private readonly header: () => string,
    private readonly limit = 1_000_000,
  ) {
    this.path = join(dir, LOG_NAME);
    this.previous = join(dir, PREVIOUS_LOG_NAME);
  }

  write(entry: LogEntry): void {
    if (this.broken) return;
    try {
      if (this.size < 0) {
        mkdirSync(this.dir, { recursive: true });
        this.size = existsSync(this.path) ? statSync(this.path).size : 0;
        this.append(`\n--- ${this.header()}\n`);
      }
      const line = logLine(entry);
      if (this.size + Buffer.byteLength(line) > this.limit) {
        renameSync(this.path, this.previous); // the one before it goes, this one becomes it
        this.size = 0;
        this.append(`--- ${this.header()} (continued)\n`);
      }
      this.append(line);
    } catch {
      // a log that can't be written is never a reason for the app to fail: it stops writing
      this.broken = true;
    }
  }

  private append(text: string): void {
    appendFileSync(this.path, text);
    this.size += Buffer.byteLength(text);
  }
}
