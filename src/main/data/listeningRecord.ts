import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { isRecord } from "@shared/guards";
import { LISTEN_FLOOR_SECS, type ListeningEvent, type ListeningRecordStats } from "@shared/model";
import { isRadioMetadata, radioTrackTitle, type ZonePlayState } from "@shared/smoip";
import { getSettings } from "./persist";

/**
 * The listening record: a full local play log as DURABLE USER DATA — the
 * streamer keeps no history, so this file is the only place a listening life
 * accumulates. Everything else here follows from that:
 *
 *  - APPEND-ONLY JSONL, one file per year (`history/<year>.jsonl` in
 *    userData). The only mutation is append, fsynced per event; Clear is
 *    file deletion (confirmed in the UI) and Export is a copy — the live
 *    file IS the export format. Derived views (counts, stats) are
 *    rebuildable reads over the files, never persisted as truth. One writer
 *    is structural: the app's single-instance lock.
 *  - IDENTITY IS CONTENT, never server object ids (ids churn — that is why
 *    presets need repair). Source/provenance fields ride along, unkeyed.
 *  - AN EVENT IS WRITTEN at ≥ LISTEN_FLOOR_SECS of real played time — the
 *    floor keeps skip-bursts invisible while still recording partials
 *    (album-completion rates and "started twice, never finished" need
 *    them). A "listen" is NEVER baked into lines: it is the derived
 *    isListen() predicate over playedSeconds + duration, one definition
 *    shared with the scrobbler.
 *  - A TORN TAIL LINE (crash mid-append) is skipped, counted, and surfaced
 *    in Settings — never silently dropped. An append failure latches a
 *    warning the Settings row shows; logging never blocks or crashes the
 *    app.
 *
 * Accumulation mirrors the scrobbler: wallclock only while state is
 * 'play', so pauses don't count and seeks can't cheat. A track's event is
 * appended when its play CLOSES (next track, stop, source change,
 * disconnect, quit) with the final playedSeconds.
 */

interface OpenPlay {
  kind: "play" | "radio-session" | "external";
  /** Identity key that decides when a push is the SAME play continuing. */
  key: string;
  startedAt: number;
  playedMs: number;
  playingSince: number | null;
  payload: Record<string, unknown>;
}

let current: OpenPlay | null = null;
/** Called after every append (and failed append) so the Settings truth row
 *  can stay live — main wires this to the renderer push. */
let notify: (() => void) | null = null;
/** Consecutive-dedupe key for announced radio tracks (station:title). */
let lastRadioTrackKey: string | null = null;
let writeError: string | null = null;

function historyDir(): string {
  return join(app.getPath("userData"), "history");
}

const yearFile = (year: number): string => join(historyDir(), `${year}.jsonl`);

/** Files whose tail this process has already verified ends on a newline. */
const cleanTails = new Set<string>();

/**
 * A crash mid-append leaves a torn final line with no newline — appending
 * straight after it would CONCATENATE the new event onto the fragment and
 * corrupt both. Before this process's first append to a file, make sure the
 * tail ends on a newline (writing one if not), so a torn line stays exactly
 * one skipped line and never spreads.
 */
function ensureCleanTail(path: string): void {
  if (cleanTails.has(path)) return;
  try {
    const size = statSync(path).size;
    if (size > 0) {
      const fd = openSync(path, "r");
      const last = Buffer.alloc(1);
      try {
        readSync(fd, last, 0, 1, size - 1);
      } finally {
        closeSync(fd);
      }
      if (last.toString("utf-8") !== "\n") appendFileSync(path, "\n");
    }
  } catch {
    // No file yet — the append below creates it.
  }
  cleanTails.add(path);
}

/** Append one event line, fsynced so a crash can tear at most the tail. */
function append(event: ListeningEvent): void {
  try {
    mkdirSync(historyDir(), { recursive: true });
    const file = yearFile(new Date(event.at).getFullYear());
    ensureCleanTail(file);
    const fd = openSync(file, "a");
    try {
      appendFileSync(fd, `${JSON.stringify(event)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    writeError = null;
  } catch (err) {
    writeError = err instanceof Error ? err.message : String(err);
    console.error("listening record append failed", err);
  }
  notify?.();
}

function closeCurrent(): void {
  if (!current) return;
  const p = current;
  current = null;
  if (p.playingSince != null) {
    p.playedMs += Date.now() - p.playingSince;
    p.playingSince = null;
  }
  const played = Math.round(p.playedMs / 1000);
  if (played < LISTEN_FLOOR_SECS) {
    // Nothing written, but the pending play is gone — the row must hear.
    notify?.();
    return;
  }
  append({
    v: 1,
    at: p.startedAt,
    tzOffsetMin: new Date(p.startedAt).getTimezoneOffset(),
    kind: p.kind,
    ...p.payload,
    playedSeconds: played,
  } as ListeningEvent);
}

function pauseCurrent(): void {
  if (current?.playingSince != null) {
    current.playedMs += Date.now() - current.playingSince;
    current.playingSince = null;
  }
}

export const listeningRecord = {
  setNotifier(fn: () => void): void {
    notify = fn;
  },

  /** Feed every /zone/play_state push through here (DeviceManager does,
   *  beside the scrobbler). `sourceName` is now_playing's display name. */
  onPlayState(ps: ZonePlayState, sourceName: string | null): void {
    if (!getSettings().listeningRecord) {
      // Off mid-playback: freeze accumulation; the open play stays open so
      // flipping the switch back on doesn't split one play into two events.
      pauseCurrent();
      return;
    }
    const md = ps.metadata;
    const isRadio = md != null && isRadioMetadata(md);
    const sourceId = md?.source ?? null;
    // Library plays come from the streamer's own queue (a queue_id is the
    // tell, USB included); radio is its own pair of kinds; anything else
    // with metadata is an external source. Metadata-less inputs (Bluetooth,
    // analog/digital passthrough): not logged, v1.
    let kind: OpenPlay["kind"] | null = null;
    let key = "";
    let payload: Record<string, unknown> = {};
    if (isRadio) {
      kind = "radio-session";
      key = `radio|${md.station ?? ""}`;
      payload = {
        station: md.station ?? null,
        radioId: md.radio_id ?? null,
      };
    } else if (md?.title && ps.queue_id != null) {
      kind = "play";
      key = `play|${md.title}|${md.artist ?? ""}|${md.album ?? ""}|${ps.queue_id}`;
      payload = {
        title: md.title,
        artist: md.artist ?? null,
        album: md.album ?? null,
        duration: md.duration ?? null,
        codec: md.codec ?? null,
        sampleRate: md.sample_rate ?? null,
        bitDepth: md.bit_depth ?? null,
        lossless: md.lossless ?? null,
        source: sourceName,
        sourceId,
      };
    } else if (md?.title) {
      kind = "external";
      key = `ext|${sourceId ?? ""}|${md.title}|${md.artist ?? ""}`;
      payload = {
        source: sourceName,
        sourceId,
        title: md.title,
        artist: md.artist ?? null,
        album: md.album ?? null,
        duration: md.duration ?? null,
      };
    }

    if (kind == null) {
      closeCurrent();
      lastRadioTrackKey = null;
      return;
    }

    if (!current || current.key !== key) {
      closeCurrent();
      current = {
        kind,
        key,
        startedAt: Date.now(),
        playedMs: 0,
        playingSince: null,
        payload,
      };
      if (!isRadio) lastRadioTrackKey = null;
      // A new open play: push so the truth row can name what it is timing.
      notify?.();
    }

    // Announced radio tracks are sightings, appended as the title changes —
    // the station session keeps accumulating around them.
    if (isRadio) {
      const title = radioTrackTitle(md);
      const trackKey = title != null ? `${md.station ?? ""}:${title}` : null;
      if (title != null && trackKey !== lastRadioTrackKey) {
        lastRadioTrackKey = trackKey;
        append({
          v: 1,
          at: Date.now(),
          tzOffsetMin: new Date().getTimezoneOffset(),
          kind: "radio-track",
          station: md.station ?? null,
          title,
          artist: md.artist ?? null,
        });
      }
    }

    // The scrobbler's accumulation rule exactly: wallclock only while the
    // state is 'play' — buffering, pause and stop all freeze the clock.
    if (ps.state === "play") {
      if (current.playingSince == null) current.playingSince = Date.now();
    } else {
      pauseCurrent();
    }
  },

  /** Connection lost, device switched, or the app is quitting: close out the
   *  open play so its time is not lost (quit is why this is synchronous). */
  flush(): void {
    closeCurrent();
    lastRadioTrackKey = null;
  },

  /** Read one year's events. Torn or unparseable lines are counted, never
   *  thrown over; unknown kinds pass through untyped (readers skip what
   *  they don't know — the additive-evolution contract). */
  readYear(year: number): { events: ListeningEvent[]; unreadable: number } {
    let raw: string;
    try {
      raw = readFileSync(yearFile(year), "utf-8");
    } catch {
      return { events: [], unreadable: 0 };
    }
    const events: ListeningEvent[] = [];
    let unreadable = 0;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed) && typeof parsed.at === "number" && typeof parsed.kind === "string") {
          events.push(parsed as unknown as ListeningEvent);
        } else {
          unreadable++;
        }
      } catch {
        unreadable++;
      }
    }
    return { events, unreadable };
  },

  /** Every event across all years, with the unreadable-line total — the MCP
   *  read tools' feedstock. Order follows the files (per year, append order). */
  async readAll(): Promise<{ events: ListeningEvent[]; unreadable: number }> {
    const events: ListeningEvent[] = [];
    let unreadable = 0;
    for (const year of await listYears()) {
      const r = this.readYear(year);
      events.push(...r.events);
      unreadable += r.unreadable;
    }
    return { events, unreadable };
  },

  /** The Settings truth row, computed fresh from the files. */
  async stats(): Promise<ListeningRecordStats> {
    let events = 0;
    let bytes = 0;
    let since: number | null = null;
    let unreadableLines = 0;
    for (const year of await listYears()) {
      bytes += (await stat(yearFile(year))).size;
      const { events: list, unreadable } = this.readYear(year);
      events += list.length;
      unreadableLines += unreadable;
      for (const e of list) if (since == null || e.at < since) since = e.at;
    }
    const pending = current
      ? ((current.payload.title as string | null | undefined) ??
        (current.payload.station as string | null | undefined) ??
        null)
      : null;
    return { events, bytes, since, unreadableLines, writeError, pending };
  },

  /** Delete the record (the UI confirms first — this cannot be undone). */
  async clear(): Promise<void> {
    this.flush();
    for (const year of await listYears()) await unlink(yearFile(year));
  },

  /** Write the whole record to one file at `path` — the years concatenated
   *  in order. The per-line envelope makes concatenation safe by design; a
   *  torn tail line stays its own line (never merged into the next year's
   *  first event). Returns the number of events written. */
  async exportToFile(path: string): Promise<number> {
    let out = "";
    let events = 0;
    for (const year of await listYears()) {
      let chunk: string;
      try {
        chunk = readFileSync(yearFile(year), "utf-8");
      } catch {
        continue;
      }
      if (chunk !== "" && !chunk.endsWith("\n")) chunk += "\n";
      out += chunk;
      events += this.readYear(year).events.length;
    }
    await writeFile(path, out);
    return events;
  },
};

async function listYears(): Promise<number[]> {
  try {
    const names = await readdir(historyDir());
    return names
      .map((n) => /^(\d{4})\.jsonl$/.exec(n)?.[1])
      .filter((y): y is string => y != null)
      .map(Number)
      .sort();
  } catch {
    return [];
  }
}
