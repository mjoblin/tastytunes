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
import { readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { isRecord } from "@shared/guards";
import { isDeviceArt } from "@shared/artUrl";
import {
  LISTEN_FLOOR_SECS,
  type ListeningEvent,
  type ListeningRecordStats,
  type ListeningVia,
  artAddress,
  artHostOf,
} from "@shared/model";
import { isRadioMetadata, radioTrackTitle, trackTitle, type ZonePlayState } from "@shared/smoip";
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
/** Called with each event that was APPENDED (never on a failed append) — main
 *  pushes it so the renderer's play stats fold it in without a re-read. */
let notifyEvent: ((event: ListeningEvent) => void) | null = null;
/** Fires when the open play crosses the floor: the truth row's promise
 *  changes shape at that moment (conditional to unconditional). */
let floorTimer: NodeJS.Timeout | null = null;

function armFloorTimer(): void {
  if (floorTimer) clearTimeout(floorTimer);
  floorTimer = null;
  if (!current || current.playingSince == null) return;
  const remainingMs = LISTEN_FLOOR_SECS * 1000 - current.playedMs;
  if (remainingMs <= 0) return;
  floorTimer = setTimeout(() => {
    floorTimer = null;
    notify?.();
  }, remainingMs + 250);
}
/** Consecutive-dedupe key for announced radio tracks (station:title). */
let lastRadioTrackKey: string | null = null;
let writeError: string | null = null;

/**
 * PLAY PROVENANCE (0.8.0): the verb that started what is playing. A preset
 * recall or a playlist activation opens a context, and the plays that begin
 * while it is open carry `via`. The context is bound to WHAT THE VERB LOADED,
 * never to time: for a queue verb, the queue entries it loaded (a play whose
 * queue_id is not one of them is not the context's, so an insert into the same
 * queue stays unattributed, and a queue that no longer holds any of them ends
 * it); for a station preset, the station (another station, or any library
 * play, ends it). Only the app's own verbs open one, so a preset pressed on the
 * streamer or a queue another app built is never attributed. The binding waits
 * for the first play after the verb: a preset's queue lands with the recall,
 * while a playlist activation appends slowly and holds the binding until its
 * batch ends, attributing the plays that start meanwhile.
 */
interface ViaContext {
  via: ListeningVia;
  openedAt: number;
  /** The loaded queue entries, once bound; null while unbound. */
  queueIds: Set<number> | null;
  /** A station preset's station, once a radio session bound it. */
  station: string | null;
  /** The verb is still loading the queue: bind on the first list after release. */
  holdBinding: boolean;
  /** A play was attributed while unbound; the next queue list binds. */
  bindOnNextQueue: boolean;
  /** A preset recall's: the queue that was there before it, and the context it replaced (see
   *  cameToNothing). Null for any other verb. */
  queueBefore: Set<number> | null;
  previous: ViaContext | null;
}
let context: ViaContext | null = null;
let lastQueueIds: Set<number> | null = null;
let lastQueueAt = 0;

function clearContext(): void {
  context = null;
}

/** A bound context can no longer come to nothing: what it replaced is let go. */
function bound(c: ViaContext): void {
  c.queueBefore = null;
  c.previous = null;
}

/** How long a preset recall may take to load its queue before it is taken to have loaded nothing:
 *  the Presets screen's dead-recall wait (8 s) and a wake's (about 3 s), with room. */
const PRESET_BIND_MS = 15_000;

/**
 * A RECALL THAT LOADED NOTHING CLAIMS NOTHING (0.13.0-rc.6, his preset 24). The streamer accepts
 * a preset whose album its server no longer has and then does nothing, and the recall's context,
 * never bound, claimed the next play anyway: a track of the queue already playing (preset 30's
 * album, credited to preset 24 in his Resume and his history). A preset recall's context still
 * unbound when a play starts from the queue that was there before it, or past PRESET_BIND_MS,
 * came to nothing: the context it replaced stands again (unit-tested).
 */
function cameToNothing(c: ViaContext, kind: OpenPlay["kind"], queueId: number | null): boolean {
  if (c.via.kind !== "preset" || c.queueIds != null || c.station != null) return false;
  if (Date.now() - c.openedAt > PRESET_BIND_MS) return true;
  return kind === "play" && queueId != null && (c.queueBefore?.has(queueId) ?? false);
}

/** The open context's `via` for a play that is starting, or nothing; binds and
 *  ends the context by the rules above. */
function attribute(
  kind: OpenPlay["kind"],
  queueId: number | null,
  station: string | null,
): ListeningVia | undefined {
  const c = context;
  if (!c || kind === "external") return undefined;
  if (cameToNothing(c, kind, queueId)) {
    context = c.previous;
    return attribute(kind, queueId, station);
  }
  if (kind === "radio-session") {
    // a queue verb's context has nothing to say about the radio
    if (c.queueIds != null || c.holdBinding || c.bindOnNextQueue) return undefined;
    if (c.station == null) {
      c.station = station;
      bound(c);
      return c.via;
    }
    if (c.station === station) return c.via;
    clearContext();
    return undefined;
  }
  if (c.station != null) {
    clearContext();
    return undefined;
  }
  if (c.queueIds == null) {
    if (!c.holdBinding) {
      // the recall's queue may already have landed; otherwise the next list binds
      if (
        lastQueueAt > c.openedAt &&
        lastQueueIds &&
        queueId != null &&
        lastQueueIds.has(queueId)
      ) {
        c.queueIds = new Set(lastQueueIds);
        bound(c);
      } else c.bindOnNextQueue = true;
    }
    return c.via;
  }
  return queueId != null && c.queueIds.has(queueId) ? c.via : undefined;
}

function historyDir(): string {
  return join(app.getPath("userData"), "history");
}

const yearFile = (year: number): string => join(historyDir(), `${year}.jsonl`);

/**
 * THE RECORD IN MEMORY (0.11.0 sweep): each year's parsed lines, kept while its file is
 * unchanged (the same size and mtime), so the Settings truth row (re-read at every append),
 * the play stats and the History reads stop re-reading and re-parsing every year at every
 * track boundary. This process's own appends extend the cached year in place; a change from
 * anywhere else (a restore, an editor, another build) is a new size or mtime, and that year
 * is read again.
 */
interface YearLines {
  size: number;
  mtimeMs: number;
  events: ListeningEvent[];
  unreadable: number;
  /** The year's first line of any kind (the record's "since"). */
  since: number | null;
}
const years = new Map<number, YearLines>();

/** One year's lines as parsed: torn or unparseable lines are counted, never thrown over;
 *  unknown kinds pass through untyped (readers skip what they don't know — the
 *  additive-evolution contract). */
function parseLines(raw: string): { events: ListeningEvent[]; unreadable: number } {
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
}

/** The year's lines, from memory while the file is unchanged; null when there is no file. */
function yearLines(year: number): YearLines | null {
  const file = yearFile(year);
  let size: number;
  let mtimeMs: number;
  try {
    ({ size, mtimeMs } = statSync(file));
  } catch {
    years.delete(year);
    return null;
  }
  const hit = years.get(year);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit;
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    years.delete(year);
    return null;
  }
  const { events, unreadable } = parseLines(raw);
  let since: number | null = null;
  for (const e of events) if (since == null || e.at < since) since = e.at;
  const lines = { size, mtimeMs, events, unreadable, since };
  years.set(year, lines);
  return lines;
}

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
    const year = new Date(event.at).getFullYear();
    const file = yearFile(year);
    // the year in memory extends in place below only while it is still the file on disk
    const cached = years.get(year);
    let upToDate = false;
    if (cached) {
      try {
        const st = statSync(file);
        upToDate = st.size === cached.size && st.mtimeMs === cached.mtimeMs;
      } catch {
        upToDate = false;
      }
    }
    ensureCleanTail(file);
    const line = `${JSON.stringify(event)}\n`;
    const fd = openSync(file, "a");
    try {
      appendFileSync(fd, line);
      notifyEvent?.(event);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    writeError = null;
    if (cached) {
      // exactly this line was added (a repaired torn tail adds a newline too: read again)
      const st = upToDate ? statSync(file) : null;
      if (st && st.size === cached.size + Buffer.byteLength(line)) {
        cached.events.push(JSON.parse(line) as ListeningEvent);
        cached.size = st.size;
        cached.mtimeMs = st.mtimeMs;
        if (cached.since == null || event.at < cached.since) cached.since = event.at;
      } else years.delete(year);
    }
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
  if (floorTimer) {
    clearTimeout(floorTimer);
    floorTimer = null;
  }
}

export const listeningRecord = {
  /** The years the record holds (one file each), ascending. */
  years(): Promise<number[]> {
    return listYears();
  },
  /** The streamers the record holds, by udn, with a line count each; null counts the
   *  lines from before the field (0.8.0). The History screen's filter reads this, so the
   *  renderer never loads every year just to learn whether there is more than one. */
  async streamers(): Promise<Array<{ streamer: string | null; count: number }>> {
    const counts = new Map<string | null, number>();
    for (const e of (await this.readAll()).events) {
      const key = typeof e.streamer === "string" ? e.streamer : null;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([streamer, count]) => ({ streamer, count }))
      .sort((a, b) => b.count - a.count);
  },
  /** The preset or playlist the open play came from, when one did. */
  currentVia(): ListeningVia | null {
    const via = current?.payload.via;
    return via != null && typeof via === "object" ? (via as ListeningVia) : null;
  },
  setEventNotifier(fn: (event: ListeningEvent) => void): void {
    notifyEvent = fn;
  },
  setNotifier(fn: () => void): void {
    notify = fn;
  },

  /** Feed every /zone/play_state push through here (DeviceManager does,
   *  beside the scrobbler). `sourceName` is now_playing's display name;
   *  `streamer` the connected device's udn, stamped on every line it plays;
   *  `streamerHost` its address, which tells its own pictures from a media
   *  server's (a play keeps a media server's picture address, never the drive's). */
  onPlayState(
    ps: ZonePlayState,
    sourceName: string | null,
    streamer: string | null,
    streamerHost: string | null = null,
  ): void {
    if (!getSettings().listeningRecord) {
      // Off mid-playback: freeze accumulation; the open play stays open so
      // flipping the switch back on doesn't split one play into two events.
      pauseCurrent();
      return;
    }
    const md = ps.metadata;
    const isRadio = md != null && isRadioMetadata(md);
    const sourceId = md?.source ?? null;
    // a disc's table of contents is no track (a stopped CD's title)
    const title = trackTitle(md);
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
        streamer,
      };
    } else if (md && title && ps.queue_id != null) {
      kind = "play";
      key = `play|${title}|${md.artist ?? ""}|${md.album ?? ""}|${ps.queue_id}`;
      payload = {
        title,
        artist: md.artist ?? null,
        album: md.album ?? null,
        duration: md.duration ?? null,
        codec: md.codec ?? null,
        sampleRate: md.sample_rate ?? null,
        bitDepth: md.bit_depth ?? null,
        lossless: md.lossless ?? null,
        source: sourceName,
        sourceId,
        // which copy it was (shared/model/copies): the picture's host always, its address only
        // where it is the copy's own (the drive's change with every standby)
        artHost: artHostOf(md.art_url),
        artUrl:
          md.art_url && !isDeviceArt(md.art_url, streamerHost) ? artAddress(md.art_url) : null,
        streamer,
      };
    } else if (md && title) {
      kind = "external";
      key = `ext|${sourceId ?? ""}|${title}|${md.artist ?? ""}`;
      payload = {
        source: sourceName,
        sourceId,
        title,
        artist: md.artist ?? null,
        album: md.album ?? null,
        duration: md.duration ?? null,
        streamer,
      };
    }

    if (kind == null) {
      closeCurrent();
      lastRadioTrackKey = null;
      return;
    }

    if (!current || current.key !== key) {
      closeCurrent();
      const via = attribute(kind, ps.queue_id ?? null, isRadio ? (md.station ?? null) : null);
      if (via) payload.via = via;
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
          streamer,
        });
      }
    }

    // The scrobbler's accumulation rule exactly: wallclock only while the
    // state is 'play' — buffering, pause and stop all freeze the clock.
    if (ps.state === "play") {
      if (current.playingSince == null) {
        current.playingSince = Date.now();
        armFloorTimer();
      }
    } else {
      pauseCurrent();
    }
  },

  /** A verb of the app's own started what plays next: a preset recall (bound on
   *  the first play, to the recall's queue or its station) or a playlist
   *  activation (`holdBinding` while its batch still appends). Replaces any
   *  open context. */
  openContext(via: ListeningVia, opts?: { holdBinding?: boolean }): void {
    const recall = via.kind === "preset";
    context = {
      via,
      openedAt: Date.now(),
      queueIds: null,
      station: null,
      holdBinding: opts?.holdBinding === true,
      bindOnNextQueue: false,
      queueBefore: recall ? lastQueueIds : null,
      previous: recall ? context : null,
    };
  },
  /** The activation's batch is over: the next queue list is what it loaded. */
  releaseContextBinding(): void {
    if (context?.holdBinding) {
      context.holdBinding = false;
      context.bindOnNextQueue = true;
    }
  },
  /** The queue was cleared, or the verb came to nothing. */
  endContext(): void {
    clearContext();
  },
  /** Every /queue/list the device pushes, batches included: binds a waiting
   *  context to the loaded entries, and ends a bound one whose entries are gone. */
  onQueue(ids: number[]): void {
    lastQueueIds = new Set(ids);
    lastQueueAt = Date.now();
    const c = context;
    if (!c) return;
    if (c.bindOnNextQueue && !c.holdBinding) {
      c.queueIds = new Set(ids);
      c.bindOnNextQueue = false;
      bound(c);
      return;
    }
    const set = c.queueIds;
    if (set && !ids.some((id) => set.has(id))) clearContext();
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
    const lines = yearLines(year);
    // a copy: the year in memory is never handed out to be sorted or spliced
    return lines
      ? { events: lines.events.slice(), unreadable: lines.unreadable }
      : { events: [], unreadable: 0 };
  },

  /**
   * WHAT A PRESET LAST PLAYED (0.13.0-rc.6, his preset 24: left with no picture, the repair had
   * nothing to find its album by). The newest play credited to the slot on this streamer whose
   * album is the slot's name as it was then; a play credited wrongly (a recall that loaded
   * nothing, before cameToNothing) names another album and is passed over. Its album, artist and
   * picture address, or null (unit-tested).
   */
  async presetLastAlbum(
    streamer: string | null,
    slot: number,
  ): Promise<{ album: string; artist: string | null; artUrl: string | null } | null> {
    const same = (a: string, b: string): boolean =>
      a.trim().toLowerCase() === b.trim().toLowerCase();
    const { events } = await this.readAll();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind !== "play" || e.via?.kind !== "preset" || e.via.id !== slot) continue;
      if (streamer != null && e.via.streamer != null && e.via.streamer !== streamer) continue;
      if (!e.album || !e.via.name || !same(e.album, e.via.name)) continue;
      return { album: e.album, artist: e.artist, artUrl: e.artUrl ?? null };
    }
    return null;
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

  /** The Settings truth row, from the years in memory (each re-read when its file changed). */
  async stats(): Promise<ListeningRecordStats> {
    let events = 0;
    let bytes = 0;
    let since: number | null = null;
    let unreadableLines = 0;
    for (const year of await listYears()) {
      const lines = yearLines(year);
      if (!lines) continue;
      bytes += lines.size;
      events += lines.events.length;
      unreadableLines += lines.unreadable;
      if (lines.since != null && (since == null || lines.since < since)) since = lines.since;
    }
    const pending = current
      ? ((current.payload.title as string | null | undefined) ??
        (current.payload.station as string | null | undefined) ??
        null)
      : null;
    const pendingSecs = current
      ? (current.playedMs +
          (current.playingSince != null ? Date.now() - current.playingSince : 0)) /
        1000
      : 0;
    return {
      events,
      bytes,
      since,
      unreadableLines,
      writeError,
      pending,
      pendingEligible: pendingSecs >= LISTEN_FLOOR_SECS,
    };
  },

  /** Delete the record (the UI confirms first — this cannot be undone). */
  async clear(): Promise<void> {
    this.flush();
    for (const year of await listYears()) await unlink(yearFile(year));
    years.clear();
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
