import type { LogEntry } from "@shared/model";

const minutes = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return `${m} ${m === 1 ? "minute" : "minutes"}`;
};

/**
 * THE LOG'S REPEATS (0.16.0-rc.8): during an outage the socket's error, every 8 to 12 seconds, and
 * discovery's "found N streamers", every 10, filled the log in about a day and pushed out the
 * wire-check notes an unseen model reports in by. The two alternate, so collapsing only a line that
 * repeats itself straight away never caught them. A line marked counted (those polling lines) said
 * again within the window of its first is counted rather than written, and its count is one line
 * once the window has passed (or at quit); every other line is written as it comes, in order.
 */
export class LogRepeats {
  private readonly runs = new Map<string, { entry: LogEntry; count: number }>();

  constructor(
    private readonly write: (entry: LogEntry) => void,
    private readonly windowMs: number,
  ) {}

  log(entry: LogEntry, counted: boolean): void {
    this.flush(entry.at, false);
    if (!counted) {
      this.write(entry);
      return;
    }
    const key = `${entry.level}|${entry.scope}|${entry.text}`;
    const run = this.runs.get(key);
    if (run) {
      run.count++;
      return;
    }
    if (this.runs.size < 32) this.runs.set(key, { entry, count: 0 });
    this.write(entry);
  }

  /** The counts of the runs whose window has passed, or of every run (at quit). */
  flush(now: number, all = true): void {
    for (const [key, run] of this.runs) {
      if (!all && now - run.entry.at <= this.windowMs) continue;
      this.runs.delete(key);
      if (run.count > 0)
        this.write({
          at: now,
          level: run.entry.level,
          scope: run.entry.scope,
          text: `${run.entry.text} (${run.count} more ${run.count === 1 ? "time" : "times"} in ${minutes(this.windowMs)})`,
        });
    }
  }
}
