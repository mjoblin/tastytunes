// Listening: the one definition of a listen, the play stats the Library's lenses fold, the
// listening record's events and sessions, and the resume run (what "carry on" means for
// the album that was playing).

import type { MediaNode } from "./media";
import { albumTracksOf, trackArtists } from "./media";

/**
 * The ONE definition of "a listen", shared by the scrobbler and the listening
 * record: a track counts once it has actually PLAYED for half its length or
 * four minutes, whichever is first — the Last.fm/Audioscrobbler convention
 * ListenBrainz also recommends. Tracks shorter than the floor never count,
 * and the floor doubles as the record's write threshold (below it a play is
 * a skip-burst, not history). Real played seconds only: pauses don't count
 * and seeks can't cheat — the accumulation rule, not this predicate, owns
 * that.
 */
export const LISTEN_FLOOR_SECS = 30;
export const LISTEN_CAP_SECS = 240;
export function listenThresholdSecs(durationSecs: number | null): number {
  return durationSecs != null ? Math.min(durationSecs / 2, LISTEN_CAP_SECS) : LISTEN_CAP_SECS;
}
/** The house definition in words — the Listens only chip, the Plays tile,
 *  anywhere a "listen" needs explaining, so no two surfaces phrase it apart. */
export const LISTEN_DEFINITION = `A listen is a play that ran for at least half its track, or ${LISTEN_CAP_SECS / 60} minutes, whichever is shorter.`;

export function isListen(playedSecs: number, durationSecs: number | null): boolean {
  if (durationSecs != null && durationSecs < LISTEN_FLOOR_SECS) return false;
  return playedSecs >= listenThresholdSecs(durationSecs);
}

/**
 * The listening record's CONTENT KEY for a track (0.8.0, the record's reading
 * surfaces): title, artist and album, each trimmed, lowercased and
 * whitespace-collapsed. The record stores tags raw and matches at read time,
 * so this is the one place the match rule lives — main builds the stats with
 * it and the renderer looks nodes up with it. Improving the match (feat.
 * stripping, diacritics) happens here and applies to all history at once.
 */
export function playKey(
  title: string | null | undefined,
  artist: string | null | undefined,
  album: string | null | undefined,
): string {
  const n = (v: string | null | undefined): string =>
    (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${n(title)}|${n(artist)}|${n(album)}`;
}

/**
 * The artist and album of a playKey (its last two parts): what a track's PICTURE shares with
 * every track of its album, so a play whose own cover is lost can show its album's (2026-10-11:
 * the streamer serves only the current track's cover, and of 25 AirPlay plays of one album
 * the device log had captured the cover once). Null when the key names no artist or no album
 * (an empty pair would match every untitled play).
 */
export function playAlbumKey(key: string): string | null {
  const last = key.lastIndexOf("|");
  const before = last > 0 ? key.lastIndexOf("|", last - 1) : -1;
  if (before < 0) return null;
  const artist = key.slice(before + 1, last);
  const album = key.slice(last + 1);
  return artist && album ? `${artist}|${album}` : null;
}

/** One track's tally in the record: recorded plays (each ≥ the 30s floor),
 *  listens (the house definition), the most recent start, and seconds heard. */
export interface PlayStat {
  plays: number;
  listens: number;
  lastAt: number;
  seconds: number;
}
/** The record aggregated for the reading surfaces: per-track tallies keyed by
 *  playKey, the most recent plays in order (for "pick up where you left
 *  off"), and when the record began. Built once by main from the files and
 *  kept current in the renderer by folding each new play event in. */
export interface PlayStats {
  tracks: Record<string, PlayStat>;
  recent: ListeningPlayEvent[];
  since: number | null;
  /** Every RUN of plays per album (keyed playKey(null, null, album)), oldest
   *  first — the album header's "played whole N times" (0.8.0 round two). */
  albumRuns: Record<string, AlbumRun[]>;
}
/** The most recent plays kept in `recent` — enough for any album run. */
export const PLAY_STATS_RECENT = 300;
/** An empty fold, for a reader that builds its own (a streamer's slice of the record). */
export function emptyPlayStats(): PlayStats {
  return { tracks: {}, recent: [], since: null, albumRuns: {} };
}

/** "Not heard in a while": an album played, then left this long (the History
 *  screen's Rediscover shelf and the MCP's history_rediscover default). */
export const REDISCOVER_QUIET_DAYS = 90;

/**
 * An album's tallies in the record: its tracks' plays summed, the latest of
 * them, and how many tracks it has, by content (playKey over albumTracksOf).
 * ONE home for "has this album been played, and when": the History screen's
 * Rediscover shelves and the MCP's history_unplayed and history_rediscover all
 * read it.
 */
export function albumTally(
  album: MediaNode,
  pool: {
    albums: ReadonlyArray<Pick<MediaNode, "title" | "artist">>;
    tracks: ReadonlyArray<MediaNode>;
  },
  stats: Pick<PlayStats, "tracks">,
): { plays: number; lastAt: number; tracks: number } {
  const tracks = albumTracksOf(album, pool);
  let plays = 0;
  let lastAt = 0;
  for (const t of tracks) {
    const st = stats.tracks[playKey(t.title, t.artist, t.album)];
    if (!st) continue;
    plays += st.plays;
    lastAt = Math.max(lastAt, st.lastAt);
  }
  return { plays, lastAt, tracks: tracks.length };
}

/** A title as a heard-elsewhere line meets the library by: lowercased, its
 *  edition suffix gone ("(Remastered 2011)", "[Deluxe Edition]", "- Live"),
 *  since a streaming service and a file rarely agree on those. */
export function editionless(title: string): string {
  return title
    .toLowerCase()
    .replace(
      /\s*[([][^)\]]*\b(?:remaster(?:ed)?|deluxe|edition|version|mono|stereo|live|bonus|expanded|anniversary)\b[^)\]]*[)\]]/g,
      "",
    )
    .replace(/\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|live|mono|stereo|radio edit)\b.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Library tracks keyed by editionless title: the index "is this in the library" asks. */
export function titleIndexOf(
  pools: ReadonlyArray<{ tracks: ReadonlyArray<MediaNode> }>,
): Map<string, MediaNode[]> {
  const index = new Map<string, MediaNode[]>();
  for (const pool of pools)
    for (const n of pool.tracks) {
      const k = editionless(n.title);
      const list = index.get(k);
      if (list) list.push(n);
      else index.set(k, [n]);
    }
  return index;
}

/**
 * Does the library hold this track? The editionless title, and, when the line
 * names one, an artist: any of the track's performers or its album artist
 * against the credit or one of the names a streaming credit packs ("A & B",
 * "A feat. B"). Content identity, the record's rule; never a server id.
 */
export function inLibraryIndex(
  index: Map<string, MediaNode[]>,
  title: string,
  artist: string | null,
): boolean {
  const candidates = index.get(editionless(title));
  if (!candidates || candidates.length === 0) return false;
  if (!artist) return true;
  const names = new Set(
    artist
      .toLowerCase()
      .split(/\s*(?:,|;|&|\band\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  names.add(artist.trim().toLowerCase());
  return candidates.some((n) =>
    [...trackArtists(n), n.albumArtist].some((a) => a != null && names.has(a.trim().toLowerCase())),
  );
}
/** Fold one record line into the stats. Library plays only: an "external"
 *  line (AirPlay, casting) never counts, even on a content match — a count
 *  means "played from the library". Main builds with it, the renderer folds
 *  each pushed event with it, so the two never disagree. */
export function foldPlayEvent(stats: PlayStats, e: ListeningEvent): void {
  if (e.kind !== "play") return;
  const ev = e;
  const k = playKey(ev.title, ev.artist, ev.album);
  const row = stats.tracks[k] ?? { plays: 0, listens: 0, lastAt: 0, seconds: 0 };
  row.plays += 1;
  if (isListen(ev.playedSeconds, ev.duration)) row.listens += 1;
  if (ev.at > row.lastAt) row.lastAt = ev.at;
  row.seconds += ev.playedSeconds;
  stats.tracks[k] = row;
  // the album's runs: this play extends the last run when the previous
  // library play was the same album within the session gap, else opens one
  if (ev.album) {
    const ak = playKey(null, null, ev.album);
    const runs = stats.albumRuns[ak] ?? (stats.albumRuns[ak] = []);
    const prev = stats.recent[stats.recent.length - 1];
    const last = runs[runs.length - 1];
    const continues =
      prev != null &&
      last != null &&
      playKey(null, null, prev.album) === ak &&
      ev.at >= prev.at &&
      ev.at - last.endAt <= SESSION_GAP_MS;
    if (!continues) runs.push({ startAt: ev.at, endAt: ev.at, plays: 0, listened: [] });
    const run = runs[runs.length - 1];
    run.plays += 1;
    run.endAt = Math.max(run.endAt, ev.at + ev.playedSeconds * 1000);
    if (isListen(ev.playedSeconds, ev.duration) && !run.listened.includes(k)) run.listened.push(k);
  }
  stats.recent.push(ev);
  if (stats.recent.length > PLAY_STATS_RECENT)
    stats.recent.splice(0, stats.recent.length - PLAY_STATS_RECENT);
  if (stats.since == null || ev.at < stats.since) stats.since = ev.at;
}

/** "Pick up where you left off": the most recent RUN of plays from one album
 *  (consecutive plays of the same album with at most `gapMs` between one
 *  play's end and the next's start), if it ended within `withinMs`. Shared
 *  by the resume card and the MCP history_resume / resume_playback tools. */
export interface ResumeRun {
  album: string;
  artist: string | null;
  /** The run's plays, in order. */
  plays: ListeningPlayEvent[];
  /** The last play in the run, and whether it counted as a listen. */
  last: ListeningPlayEvent;
  lastListened: boolean;
}
export function resumeRun(
  recent: ReadonlyArray<ListeningPlayEvent>,
  now: number = Date.now(),
  { withinMs = 7 * 86_400_000, gapMs = 30 * 60_000 } = {},
): ResumeRun | null {
  if (recent.length === 0) return null;
  const last = recent[recent.length - 1];
  if (!last.album) return null;
  const endOf = (e: ListeningPlayEvent): number => e.at + e.playedSeconds * 1000;
  if (now - endOf(last) > withinMs) return null;
  const key = (e: ListeningPlayEvent): string => playKey(null, null, e.album);
  const plays: ListeningPlayEvent[] = [last];
  for (let i = recent.length - 2; i >= 0; i--) {
    const e = recent[i];
    if (key(e) !== key(last)) break;
    if (plays[0].at - endOf(e) > gapMs) break;
    plays.unshift(e);
  }
  return {
    album: last.album,
    artist: last.artist,
    plays,
    last,
    lastListened: isListen(last.playedSeconds, last.duration),
  };
}

/** Given the album's tracks in running order, the track to resume from: the
 *  one after the last listened track, or the interrupted track itself when
 *  the last play never became a listen. Null when the run reached the end. */
export function resumeTarget(run: ResumeRun, tracks: ReadonlyArray<MediaNode>): MediaNode | null {
  if (tracks.length < 2) return null;
  const idx = tracks.findIndex(
    (t) => playKey(t.title, null, null) === playKey(run.last.title, null, null),
  );
  if (idx < 0) return null;
  if (!run.lastListened) return tracks[idx];
  return idx + 1 < tracks.length ? tracks[idx + 1] : null;
}

/**
 * One line of the listening record (history/<year>.jsonl in userData).
 *
 * The envelope is versioned PER LINE (`v`) so exported files survive
 * concatenation across versions, carries the tz offset for day-boundary
 * stats, and evolves ADDITIVELY ONLY: readers skip unknown fields and
 * unknown kinds, which is what makes future event types (diary notes, skip
 * events, action events) additive rather than migrations. Tag values are
 * stored RAW — normalization is the matcher's job at read time, so matching
 * can improve without rewriting history. `at` is when the play STARTED
 * (epoch ms); `tzOffsetMin` is `Date#getTimezoneOffset()` at write time.
 */
export interface ListeningEventBase {
  v: 1;
  at: number;
  tzOffsetMin: number;
  kind: string;
  /** The streamer that played it, by udn (0.8.0 on, additive): the record is one
   *  listening life across every streamer the app has driven, and this is what
   *  lets a reader narrow it to one. Lines written before it carry none. */
  streamer?: string | null;
}
/** How a play was STARTED, when one of TastyTunes' own verbs started it (0.8.0,
 *  additive): a preset recall or a playlist activation. It rides on play and
 *  radio-session lines only while what the verb loaded is what is playing (its
 *  queue entries, or its station); a preset pressed on the streamer or a queue
 *  another app built never carries it, so a reader must say "started from
 *  TastyTunes", never "played from a preset". */
/**
 * WHAT THE STREAMER WAS DOING WHEN IT WENT TO SLEEP (0.10.0, user ask 2026-10-06: "the state i
 * was in when i put the streamer in standby is being resumed"). The streamer reports nothing
 * while it sleeps, so the app keeps this itself, per streamer, saved across restarts: the
 * standby face offers it and Resume puts it back. Four kinds, from what the Evo keeps through
 * network standby (live-probed 2026-10-06): a queue track (the same entry comes back paused,
 * but at 0:00, so the position is the app's to remember), a station (it comes back and
 * reconnects by itself), a streaming service (AirPlay comes back on its input with no track:
 * the session lived on the phone), an input (it comes back on the same input, unless a TV on
 * HDMI pulls it onto ARC).
 */
export interface HeldState {
  /** The streamer's udn. */
  streamer: string;
  /** When the app last saw this state live. */
  at: number;
  kind: "queue" | "radio" | "service" | "input";
  /** The source to come back on: MEDIA_PLAYER, IR, AIRPLAY, SPDIF_TOSLINK… */
  sourceId: string;
  sourceName: string | null;
  /** The track's title, or the station's name. */
  title: string | null;
  artist: string | null;
  album: string | null;
  artUrl: string | null;
  /** A queue track: its queue entry, how far into it, and its length (seconds). */
  queueId: number | null;
  position: number | null;
  duration: number | null;
  /** The preset or playlist that started it, when one did. */
  via: ListeningVia | null;
}

export type ListeningVia =
  /** A preset is a slot on one streamer, so the streamer's udn is part of its identity
   *  (slot 3 on two streamers are two presets); null only when the device never said. */
  | { kind: "preset"; id: number; name: string | null; streamer: string | null }
  | { kind: "playlist"; id: string; name: string };
/** A library play (MEDIA_PLAYER, USB included) — the only kind that feeds
 *  play counts. Format facts are captured at play time; provenance fields
 *  ride along where known but are never identity. */
export interface ListeningPlayEvent extends ListeningEventBase {
  kind: "play";
  title: string;
  artist: string | null;
  album: string | null;
  playedSeconds: number;
  duration: number | null;
  codec: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  lossless: boolean | null;
  source: string | null;
  sourceId: string | null;
  via?: ListeningVia;
}
/** A stretch of internet radio on one station — "heard", never a listen. */
export interface ListeningRadioSessionEvent extends ListeningEventBase {
  kind: "radio-session";
  station: string | null;
  radioId: number | null;
  playedSeconds: number;
  via?: ListeningVia;
}
/** A track a station announced during a session (keyed station:title, the
 *  recents convention) — a sighting, with no played-time semantics. */
export interface ListeningRadioTrackEvent extends ListeningEventBase {
  kind: "radio-track";
  station: string | null;
  title: string;
  artist: string | null;
}
/** Playback from an external source (AirPlay, Chromecast, the streamer's own
 *  services) — logged with its source, excluded from library counts even on
 *  a content match: a count means "played from the library". */
export interface ListeningExternalEvent extends ListeningEventBase {
  kind: "external";
  source: string | null;
  sourceId: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  playedSeconds: number;
  duration: number | null;
}
export type ListeningEvent =
  | ListeningPlayEvent
  | ListeningRadioSessionEvent
  | ListeningRadioTrackEvent
  | ListeningExternalEvent;

/** A LISTENING SESSION (0.8.0, History round two): consecutive record lines
 *  with at most SESSION_GAP_MS between one line's end and the next's start,
 *  over every kind — a library run, a radio stretch, an AirPlay evening, or
 *  one evening spanning them. The Timeline's unit; whole-album listens
 *  (albumRuns) use the same gap. */
export const SESSION_GAP_MS = 30 * 60_000;

export interface ListeningSession {
  startAt: number;
  endAt: number;
  /** In time order. */
  events: ListeningEvent[];
}

/** When a line's play ended: its start plus the seconds it played (a radio
 *  sighting has no played time and ends where it starts). */
export function eventEnd(e: ListeningEvent): number {
  return (
    e.at +
    ("playedSeconds" in e && typeof e.playedSeconds === "number" ? e.playedSeconds * 1000 : 0)
  );
}

export function groupSessions(
  events: readonly ListeningEvent[],
  gapMs: number = SESSION_GAP_MS,
): ListeningSession[] {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const out: ListeningSession[] = [];
  for (const e of sorted) {
    const cur = out[out.length - 1];
    if (cur && e.at - cur.endAt <= gapMs) {
      cur.events.push(e);
      cur.endAt = Math.max(cur.endAt, eventEnd(e));
    } else out.push({ startAt: e.at, endAt: eventEnd(e), events: [e] });
  }
  return out;
}

/** One RUN of plays from one album (consecutive library plays of the same
 *  album, SESSION_GAP_MS apart at most), with the distinct tracks heard as
 *  LISTENS — the renderer decides "whole" against the album's indexed tracks,
 *  since the record carries no track counts. */
export interface AlbumRun {
  startAt: number;
  endAt: number;
  plays: number;
  listened: string[];
}

/** The Settings truth row: what the record holds and whether writes work. */
export interface ListeningRecordStats {
  events: number;
  bytes: number;
  /** Epoch ms of the earliest event, or null for an empty record. */
  since: number | null;
  /** Torn/unparseable lines encountered while reading — surfaced, never
   *  silently dropped. */
  unreadableLines: number;
  /** The last append failure (disk full, permissions), or null while writes
   *  are healthy. */
  writeError: string | null;
  /** The open play being timed right now (its title, or the station), or
   *  null while nothing plays. Not yet on disk: it is written when the play
   *  closes. */
  pending: string | null;
  /** True once the open play has crossed the floor, so closing it WILL
   *  write an event; false while a change would still discard it. */
  pendingEligible: boolean;
}
