// The app's own DOMAIN — the things TastyTunes stores and reasons about,
// independent of how they travel.
//
// Split out of ipc.ts 2026-07-26. The rule for what lives here: a type belongs
// in this file if it would still mean something with the IPC layer deleted —
// the local recently-played log, favorites, playlists, and the content-identity
// helpers that make all three survive a media server re-indexing. Message
// shapes, channel names and the preload API stay in ipc.ts, which imports FROM
// here; nothing in this file may import from ipc.ts, and that one-way edge is
// what keeps the contract free of domain churn.
//
// smoip.ts is the other direction entirely — the STREAMER's wire types. This
// file may read from it (a recent entry is matched against a play_state, a
// playlist hashes with the same core a live queue does); it never writes to it.

import type { SmoipFrame, ZonePlayState } from "./smoip";
import { contentRowsHash, isRadioMetadata, radioTrackTitle } from "./smoip";

// --------------------------------------------------------------- recently played

/**
 * One entry in the local recently-played log. The streamer keeps no history, so
 * the main process records each track it sees pass through /zone/play_state.
 * A bounded convenience log — explicitly not a database.
 */
export interface RecentTrack {
  /** When the track first appeared (ms epoch). */
  at: number;
  /** Song title. Null for a songless state (radio that emits no song, or echoes its own name). */
  title: string | null;
  artist: string | null;
  album: string | null;
  /** Set for internet radio — the station name (title then carries the song). */
  station: string | null;
  artUrl: string | null;
  /** Human source label (e.g. "Media Library", "AirPlay"), best-effort. */
  source: string | null;
  /** SMOIP source id (e.g. "AIRPLAY", "IR", "MEDIA_PLAYER") — lets a row re-activate the source. */
  sourceId: string | null;
  /** Queue item id at record time — lets a local row replay the track if it's still queued. */
  queueId: number | null;
  isRadio: boolean;
  /** Airable radio id, if any — used to match a station back to a preset for re-tuning. */
  radioId: number | null;
  /**
   * Grouping key for continuous sessions. `radio:<station>` or `src:<sourceId>` for
   * sources whose now-playing song changes over one continuous session; null for a
   * discrete queued track, which never groups. Optional so pre-upgrade logs still load.
   */
  session: string | null;
}

/**
 * Does a recently-played entry describe what /zone/play_state currently
 * reports? Mirrors the recording normalization in main/data/recents.ts (title-keyed;
 * a radio "song" that's absent or just echoes the station name is null), so the
 * Recently Played screen can mark its head entry live without drifting from how
 * entries were written.
 */
export function recentMatchesPlayState(e: RecentTrack, ps: ZonePlayState | null): boolean {
  const md = ps?.metadata;
  if (!md) return false;
  const eq = (a: string | null | undefined, b: string | null | undefined): boolean =>
    (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  const isRadio = isRadioMetadata(md);
  if (e.isRadio !== isRadio) return false;
  if (isRadio) {
    return eq(e.station, md.station) && eq(e.title, radioTrackTitle(md));
  }
  return e.title != null && eq(e.title, md.title);
}

// -------------------------------------------------------------------- favorites

/**
 * A favorited radio station. The stream URL is the identity — playing needs
 * no resolution at all (streamRadio with the stored url+name). The
 * radio-browser uuid is a recovery hint for URL rot: an on-demand re-lookup,
 * user-initiated only (never a click-ping — the privacy stance holds).
 */
export interface FavoriteStation {
  kind: "station";
  addedAt: number;
  name: string;
  url: string;
  favicon: string | null;
  radioBrowserUuid: string | null;
}

/**
 * A favorited album or track, keyed on CONTENT identity (title/artist/album)
 * — UPnP object ids rot, so `objectId` is only a fast-path hint and playing
 * falls back to a scoped library search. `serverUdn` is where it was hearted
 * (null for content-only entries from the Now Playing heart); `titlePath` is
 * the breadcrumb trail at heart time, feeding the browse re-walk.
 */
export interface FavoriteMedia {
  kind: "album" | "track";
  addedAt: number;
  title: string;
  artist: string | null;
  /** Tracks only — the album the track belongs to. */
  album: string | null;
  artUrl: string | null;
  serverUdn: string | null;
  serverName: string | null;
  objectId: string | null;
  titlePath: string[] | null;
  /** Track length in seconds, captured at heart time (tracks; null when the
   *  source had none — favorites hearted before this field show blank). */
  durationSecs?: number | null;
}

export type Favorite = FavoriteStation | FavoriteMedia;

/**
 * Content identity — dedupe and heart-lit checks. Stations key on the URL;
 * media keys on lowercased content fields, deliberately WITHOUT the server
 * (the same album on two servers is the same music).
 */
/**
 * A multi-volume set member: "Nature's Best 2 [Disc 1]", "Symphonies Vol. 3",
 * "Anthology, Part 2". Base + volume when the title carries a trailing
 * disc/volume/part marker; null otherwise. Same FULL title twice (two
 * editions of one album) is deliberately NOT a set — no marker, no match.
 */
const VOLUME_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};
const VOLUME_ROMAN: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
  xiii: 13,
  xiv: 14,
  xv: 15,
  xvi: 16,
  xvii: 17,
  xviii: 18,
  xix: 19,
  xx: 20,
};

export function albumVolume(title: string): { base: string; volume: number } | null {
  // The value can be digits, a spelled-out word (one–twenty) or a Roman
  // numeral (I–XX) — real servers produce all three. The keyword is still
  // required, so "Rocky IV" and "Formula One" never parse; a candidate that
  // is not a real word or numeral (e.g. "Part Time") resolves to null.
  const m =
    /^(.*?)[\s\-–—:,]*[[(]?\s*(?:disc|disk|cd|vol(?:ume)?\.?|part|pt\.?)\s*(\d+|[a-z]+)\s*[\])]?\s*$/i.exec(
      title.trim(),
    );
  if (!m || !m[1].trim()) return null;
  const raw = m[2].toLowerCase();
  const volume = /^\d+$/.test(raw) ? Number(raw) : (VOLUME_WORDS[raw] ?? VOLUME_ROMAN[raw] ?? null);
  if (volume == null) return null;
  return { base: m[1].trim(), volume };
}

/**
 * Sort key for an artist name: a leading "The " files under what follows (The
 * Cure under C) — display never changes, only ordering and the A–Z rail.
 * Deliberately ONLY "The": stripping "A "/"An" is where conventions disagree
 * (A Tribe Called Quest divides rooms), so we take the unambiguous case and
 * stop. Titles keep their articles; this is for people and groups.
 */
export function nameSortKey(name: string): string {
  return /^the /i.test(name) ? name.slice(4) : name;
}

export function favoriteKey(f: Favorite): string {
  const lc = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();
  if (f.kind === "station") return `station:${f.url}`;
  if (f.kind === "album") return `album:${lc(f.title)}:${lc(f.artist)}`;
  return `track:${lc(f.title)}:${lc(f.artist)}:${lc(f.album)}`;
}

// -------------------------------------------------------------------- playlists

/**
 * One track in a stored playlist.
 *
 * IDENTITY DISCIPLINE (the thing that makes playlists survivable): the CONTENT
 * — title/artist/album — is the durable key, and serverUdn/objectId are a fast
 * path that gets HEALED when a media server re-indexes. vibin stored bare media
 * ids and matched on id equality, which is why its playlist activation needs a
 * "skipped, not found on media server" counter. We already solved this twice
 * (favoriteKey + objectId healing, queueContentHash); this is the same answer.
 */
export interface PlaylistItem {
  title: string;
  artist: string | null;
  album: string | null;
  artUrl: string | null;
  serverUdn: string | null;
  serverName: string | null;
  /** Fast path only — may be stale, and is re-resolved from content on a miss. */
  objectId: string | null;
  durationSecs?: number | null;
}

/**
 * A track identified by CONTENT alone — the one currency both content-resolve
 * callers speak (a playlist entry whose objectId rotted, a removed queue row
 * that never had one). Defined once here so the two can't drift apart.
 */
export interface ContentRef {
  title: string;
  artist?: string | null;
  album?: string | null;
}

/**
 * Queue undo is a re-resolve, not a rollback, so it reports which happened:
 * 'not-found' = the track couldn't be found on any server (say so — the user
 * is looking at a queue it didn't reappear in), 'failed' = the streamer or the
 * connection refused, 'ok' = it's back (possibly not in its old slot; see
 * queueRestore). An ok carries the queue id the row landed under when the
 * re-announce arrived in time — the renderer's arrival wash keys on it.
 */
export type QueueRestoreResult =
  { status: "ok"; id?: number } | { status: "not-found" } | { status: "failed" };

/** A stored, ordered collection of tracks. Bounded local JSON, no database. */
export interface Playlist {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Last time this playlist was activated. Optional: playlists stored before
   *  this field existed simply have no last-played date to show. */
  lastPlayedAt?: number | null;
  /** Titles the last activation couldn't find on any server. Kept so the gap
   *  is visible later, not just in the banner you dismissed at the time. */
  lastMissing?: string[];
  items: PlaylistItem[];
}

/**
 * Live progress of a playlist activation. Activation is inherently SLOW —
 * entries can only be added to the streamer's queue one at a time, and each
 * needs its media server's metadata first, so it is ~2 round-trips per track.
 * The renderer shows this; `missed` names what couldn't be found rather than
 * failing the whole run (partial activation is a normal outcome, not an error).
 */
export interface PlaylistActivation {
  playlistId: string;
  name: string;
  total: number;
  done: number;
  added: number;
  missed: string[];
  cancelled: boolean;
  finished: boolean;
}

/**
 * Bounds that keep "a bounded local file" honest (favorites are unbounded
 * because they're small and deliberate; a playlist collection is neither).
 */
export const MAX_PLAYLISTS = 100;
export const MAX_PLAYLIST_ITEMS = 500;

/**
 * Rings the main process keeps AND the renderer mirrors (2026-08-16, one
 * number each): the diagnostics drawer's frame and log rings, the Requests
 * console's ring, and the recently-played log. The renderer's copy trims to
 * the same bound so a re-opened drawer shows exactly what main holds; the
 * Recently Played footer quotes MAX_RECENTS rather than a literal.
 */
export const FRAME_RING_SIZE = 300;
export const LOG_RING_SIZE = 300;
export const NET_RING_SIZE = 200;
export const MAX_RECENTS = 200;

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
}
/** The most recent plays kept in `recent` — enough for any album run. */
export const PLAY_STATS_RECENT = 300;
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
}
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
}
/** A stretch of internet radio on one station — "heard", never a listen. */
export interface ListeningRadioSessionEvent extends ListeningEventBase {
  kind: "radio-session";
  station: string | null;
  radioId: number | null;
  playedSeconds: number;
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

/**
 * A playlist's content hash in the SAME shape queueContentHash produces for a
 * live queue, so the two can be compared directly. That comparison is how a
 * playlist knows it's the thing currently queued — content-based, so it also
 * recognises a queue loaded before the app started, or by another controller,
 * exactly like the playing-preset match.
 */
export function playlistContentHash(items: PlaylistItem[]): string {
  // Delegates to the ONE hash core queueContentHash uses — these two are
  // compared for equality, so a fork here would silently kill the marker.
  return contentRowsHash(items);
}

/**
 * Content identity for a playlist entry — deliberately the same shape as
 * favoriteKey's track form, so an item and a hearted track resolve the same
 * way and the healing path can be shared.
 */
export function playlistItemKey(i: PlaylistItem): string {
  const lc = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();
  return `track:${lc(i.title)}:${lc(i.artist)}:${lc(i.album)}`;
}

/**
 * A playlist's runtime, from the durations it knows — items without one simply
 * don't count, so a partly-unknown playlist shows an honest partial total
 * rather than nothing. One home (the Playlists screen and the tray panel both
 * show it); callers gate on `> 0` for the all-unknown case.
 */
export function playlistTotalSecs(p: Playlist): number {
  return p.items.reduce((n, i) => n + (i.durationSecs ?? 0), 0);
}

// ===========================================================================
// Second pass (2026-07-26): everything below moved from ipc.ts under the
// rule stated in this file's header — each of these would still mean
// something with the IPC layer deleted. Connection and MCP status are
// runtime DOMAIN state (the manager tracks them regardless of transport);
// settings are the persisted domain par excellence; the media-browser,
// radio, schedule, lyrics, artist, sleep, update and diagnostics shapes are
// what the app reasons about, not how it talks about them.
// ===========================================================================

// ------------------------------------------------------------------- connection

export type ConnectionState =
  | { phase: "idle" }
  | { phase: "connecting"; host: string; attempt: number; demo?: boolean }
  | { phase: "connected"; host: string; demo?: boolean }
  | { phase: "disconnected"; host: string; reason: string; reconnecting: boolean; demo?: boolean };

export interface DiscoveredDevice {
  host: string;
  friendlyName: string;
  model: string;
  udn: string;
  descriptionUrl: string;
}

// ------------------------------------------------------------------ diagnostics

export interface LogEntry {
  at: number;
  level: "info" | "warn" | "error";
  scope: string;
  text: string;
}

export interface FrameEntry {
  at: number;
  dir: "in" | "out";
  frame: SmoipFrame;
}

/** A newer GitHub release than the running version (stage-1 update awareness). */
export interface UpdateInfo {
  /** Bare version, no leading v. */
  version: string;
  /** Release page to open in the browser. */
  url: string;
}

/**
 * The self-update consent flow (Sparkle-style). Nothing downloads or installs
 * without an explicit user action at each step:
 * idle → available —[user: Download]→ downloading → downloaded —[user: Restart
 * now, or silently on next quit]→ installed. `canDownload` is false in
 * unpackaged/dev builds, where "available" only offers the release page.
 */
export interface UpdateState {
  phase: "idle" | "available" | "downloading" | "downloaded" | "error";
  /** Version on offer (bare, no leading v); null while idle. */
  version: string | null;
  /** Download progress 0–100 while downloading. */
  percent: number | null;
  /** In-app download/install possible (packaged build with a release feed). */
  canDownload: boolean;
  /** Release page — always available as the manual path. */
  url: string;
  /** Human-readable failure when phase === 'error'. */
  error: string | null;
}

/**
 * Outcome of a user-initiated release check (the Updates tab's Check now
 * button). 'update' also lands through the normal updateState push — the
 * result exists so the UI can say "nothing new" or show the failure.
 */
export type UpdateCheckResult =
  { status: "update"; version: string } | { status: "none" } | { status: "error"; error: string };

/**
 * Streamer FIRMWARE status, camelCased from the read-only /system/update push
 * (raw SystemUpdate in smoip.ts). Distinct from UpdateState above, which is the
 * APP's own self-update flow. PASSIVE ONLY — the streamer reports its own
 * self-check; TastyTunes surfaces it but never triggers a check or an install
 * (that stays the user's job via the Cambridge Audio app or the streamer's web
 * admin). There is deliberately no command to change any of this.
 */
export interface FirmwareStatus {
  updateAvailable: boolean;
  updating: boolean;
  earlyUpdate: boolean;
}

// ------------------------------------------------------------ requests console

/** One outbound HTTP request from the main process, for the diagnostics drawer. */
export interface NetRequestEntry {
  id: number;
  at: number;
  /** Short service tag: lrclib, musicbrainz, wikidata, wikipedia, listenbrainz, github, art. */
  service: string;
  method: string;
  url: string;
  /** HTTP status once a response arrived; null while pending. */
  status: number | null;
  /** Round-trip ms once settled; null while pending. */
  ms: number | null;
  /** Transport failure — no response at all (DNS, timeout, refused). */
  error: boolean;
}

// ----------------------------------------------------------- scheduled actions

/**
 * A BluOS-style alarm, executed by the main process while the app runs:
 * wake (power ON, optionally recall a preset and set a volume) or standby.
 */
export interface Schedule {
  id: string;
  enabled: boolean;
  /** Local 24h "HH:MM". */
  time: string;
  /** Days it fires: 0 = Sunday … 6 = Saturday. Empty = never. */
  days: number[];
  action: "on" | "standby";
  /** Wake only: preset to recall after powering on. */
  presetId: number | null;
  /** Wake only: volume to set after the preset settles. */
  volumePercent: number | null;
  /** Wake only, with a volume: ramp up to it instead of jumping (absent = true). */
  fadeIn?: boolean;
}

/**
 * Volume fade length for the sleep timer's fade-out and a wake schedule's
 * fade-in, one constant for both directions. Test harnesses shrink it via
 * TASTYTUNES_FADE_MS; there is deliberately no user knob (a good constant
 * beats a knob, the standing instinct).
 */
export const VOLUME_FADE_MS = 60_000;

/**
 * A wake schedule that came due while the computer was asleep, offered rather
 * than fired (see main/app/scheduler.ts). Held in the main process, mirrored to the
 * renderer so the Schedules tab can show it too — the OS notification is the
 * loud surface, this is the one that survives Do Not Disturb.
 *
 * Ephemeral by design: it dies with the app, like the countdown and lastFired.
 * A missed alarm is only interesting for as long as acting on it still makes
 * sense.
 */
export interface MissedSchedule {
  scheduleId: string;
  /** When it was due — the UI says so, because "missed" without a time is noise. */
  dueAt: number;
}

/** Cache key for a preset volume override — device-scoped so ids don't collide. */
export function presetVolumeKey(udn: string | null | undefined, presetId: number): string {
  return `${udn ?? "device"}|${presetId}`;
}

// ------------------------------------------------------------- artist context

export interface ArtistInfo {
  /** MusicBrainz's canonical name for the matched artist. */
  name: string;
  /** Wikipedia summary extract, when the chain resolved one. */
  summary: string | null;
  wikipediaUrl: string | null;
  musicbrainzUrl: string | null;
}

export interface AlbumInfo {
  /** MusicBrainz's canonical title for the matched release group. */
  title: string;
  /** Year of first release, e.g. "2011". */
  year: string | null;
  /** Release-group primary type, e.g. "Album", "EP". */
  type: string | null;
  /** Label of the earliest release, when known. */
  label: string | null;
  /** MusicBrainz genre tags, most-voted first. */
  genres: string[];
  /** Release-level relationship credits (producer etc.), when MB has them. */
  credits: Array<{ role: string; name: string }>;
  /** Wikipedia summary extract, when the chain resolved one. */
  summary: string | null;
  wikipediaUrl: string | null;
  musicbrainzUrl: string | null;
}

export interface TrackInfoQuery {
  artist: string;
  title: string;
  album: string | null;
  /** Playing length in seconds, if known — disambiguates same-titled recordings. */
  duration: number | null;
}

export interface TrackCredit {
  /** Human role: an instrument name, "Lead vocals", "Producer", "Composer"… */
  role: string;
  name: string;
}

/**
 * Recording-level credits for the playing track — who is actually ON it.
 * Groups mirror how MusicBrainz relates people to a recording: performers
 * (instrument/vocal relationships on the recording), production (producer,
 * engineering, mixing), and writing (composer/lyricist from the linked work).
 * Any group can be empty; coverage varies a lot by catalogue era.
 */
export interface TrackInfo {
  /** MusicBrainz's canonical title for the matched recording. */
  title: string;
  performers: TrackCredit[];
  production: TrackCredit[];
  writing: TrackCredit[];
  musicbrainzUrl: string | null;
}

// ------------------------------------------------------------------- lyrics

export interface LyricsQuery {
  artist: string;
  title: string;
  album: string | null;
  /** Track length in seconds, if known — LRCLIB uses it for exact matching. */
  duration: number | null;
}

export interface LyricsResult {
  plain: string | null;
  /** LRC-format synced lyrics ("[mm:ss.xx] line"), when the record has them. */
  synced: string | null;
  instrumental: boolean;
}

// ------------------------------------------------------------------- MCP server

/** Which interface the MCP server binds to. */
export type McpBind = "localhost" | "lan";

export interface McpSettings {
  /** Master switch — the server only exists while this is on. */
  enabled: boolean;
  /** localhost = this computer only; lan = any machine on the network. */
  bind: McpBind;
  port: number;
  /** Cluster ids switched off (everything is on by default). */
  disabledClusters: string[];
  /** Opt-in cluster ids the user explicitly enabled (write-capable clusters
   *  are OFF until they appear here). */
  enabledClusters: string[];
  /** Individual tool names switched off. */
  disabledTools: string[];
}

export interface McpStatus {
  running: boolean;
  /** Reachable endpoint while running, e.g. http://192.168.1.20:8555/mcp. */
  url: string | null;
  error: string | null;
}

// The CATALOG — MCP_CLUSTERS, McpClusterInfo, McpToolInfo, mcpClusterEnabled —
// lives in mcpCatalog.ts (2026-07-26). What the server is configured WITH stays
// here (it is part of AppSettings); what it OFFERS is the catalog's business.

// ------------------------------------------------------------------- sleep timer

/** What the sleep timer does when it expires. */
export type SleepAction = "pause" | "standby";

/**
 * A live sleep timer. Ephemeral by design — a countdown shouldn't survive a
 * restart. Owned by the main process (so it outlives the window on macOS);
 * renderers arm/disarm via setSleep and mirror state from pushes.
 * `minutes: null` means "end of the current track", in which case `trackKey`
 * is the armed track's identity and `firesAt` is unused.
 */
/** Countdown sleep timers fade the volume down over the last VOLUME_FADE_MS
 *  (pre-amp mode only; the level is restored after the action so tomorrow's
 *  first play isn't a whisper). End-of-track timers fire at a boundary the
 *  app can't see coming, so they never fade. */
export interface SleepTimer {
  action: SleepAction;
  minutes: number | null;
  firesAt: number | null;
  trackKey: string | null;
}

/**
 * Identity of the currently-playing track, used to detect the boundary for an
 * "end of track" sleep timer. Queue playback gives a stable per-item id; other
 * sources (AirPlay, USB) fall back to title/artist. Null when nothing
 * identifiable is playing. Shared so the arming renderer and the firing main
 * process can never disagree.
 */
export function sleepTrackKey(ps: ZonePlayState | null): string | null {
  if (!ps) return null;
  if (ps.queue_id != null) return `q${ps.queue_id}`;
  const md = ps.metadata;
  if (md?.title) return `t:${md.title}:${md.artist ?? ""}`;
  return null;
}

// ---------------------------------------------------------------------- settings

export type Theme = "dark" | "light";
/** Stored preference: an explicit theme, or follow the OS. */
export type ThemePreference = Theme | "system";

/** The display face ("money font") — a curated, bundled set. The array is the
 *  single source of truth for valid ids (persist.ts coerces unknown values to
 *  the default; the renderer builds its labelled picker from the same ids). */
export const DISPLAY_FONT_IDS = [
  "fraunces",
  "unbounded",
  "newsreader",
  "hanken",
  "instrument-serif",
  "schibsted",
  "instrument-sans",
] as const;
export type DisplayFont = (typeof DISPLAY_FONT_IDS)[number];
/** How a collection screen lays out its items. */
export type ScreenLayout = "rows" | "cards";
/** The queue alone adds an album-grouped reading view (cover once, tracks beneath). */
export type QueueLayout = ScreenLayout | "albums";
/** Motion effects: follow the OS Reduce Motion setting, or force on/off. */
export type MotionMode = "system" | "on" | "off";
export type AmbientArtMode = "off" | "now-playing" | "all";
export type AmbientCoverage = "main" | "window";
export type AlignH = "left" | "center" | "right";
export type AlignV = "top" | "center" | "bottom";

/**
 * A streamer this app has actually connected to — the device book behind
 * multi-streamer households. Keyed by UDN (identity), because the ADDRESS is
 * only a hint: every sweep or connect that sees the device again refreshes
 * `host` and `lastSeenAt` in place, so a DHCP reassignment self-heals. The
 * book never ages by clock — a summer-house streamer seen twice a year is
 * exactly what it exists to remember; the only exits are the LRU cap and the
 * user's explicit Forget.
 */
export interface KnownDevice {
  udn: string;
  host: string;
  friendlyName: string;
  model: string;
  lastSeenAt: number;
}

/** LRU cap on the device book — nobody owns eight streamers; churners get
 *  least-recently-seen eviction for free. */
export const KNOWN_DEVICES_MAX = 8;

/**
 * How long a failing reconnect keeps the benefit of the doubt. Under this,
 * the loss reads as a blip (Wi-Fi hiccup, reboot) and the app just retries;
 * past it, the device is treated as GONE — the connect gate un-walls into
 * the full surface and the single-candidate auto-connect may act. Eco
 * standby powers the network interface down, so an eco-configured device
 * skips the doubt entirely at the gate.
 */
export const RECONNECT_GRACE_MS = 15_000;

export interface AppSettings {
  lastHost: string | null;
  /** Every streamer ever connected — see KnownDevice. */
  knownDevices: KnownDevice[];
  mediaKeys: boolean;
  volumeLimitPercent: number | null;
  notifications: boolean;
  /**
   * A TastyTunes icon in the system tray / menu bar, with a context menu that
   * reaches the streamer without opening a window. Companion to the main
   * window, never a replacement — see main/app/tray.ts.
   *
   * Default OFF, and deliberately a knob rather than a heuristic (the usual
   * "a better default beats a new knob" rule was checked): a permanent icon in
   * someone's menu bar has no defensible default and, unlike a toast, can't be
   * discovered and dismissed.
   */
  tray: boolean;
  /**
   * The "TastyTunes is still running" notice has been shown once. Internal
   * one-shot state, not a preference — there is no UI for it. Closing the last
   * window with a tray icon present leaves the app alive, and silently
   * surviving a close is how apps earn a reputation for being un-quittable.
   */
  trayCloseNoticeShown: boolean;
  theme: ThemePreference;
  displayFont: DisplayFont;
  /** Blurred album-art backdrop. */
  ambientArt: AmbientArtMode;
  /** Backdrop extent: the main content area, or the whole window (nav + bar too). */
  ambientCoverage: AmbientCoverage;
  vignette: boolean;
  accentFollowsArt: boolean;
  /** Preset grid: base card width in px. */
  presetCardSize: number;
  /** Preset grid: gap between cards in px. */
  presetGap: number;
  /** Preset grid: stretch cards to fill each row (true) or keep them exact-size (false). */
  presetFillRows: boolean;
  /** Now Playing content placement. */
  nowPlayingAlignH: AlignH;
  nowPlayingAlignV: AlignV;
  /** Left nav reduced to icons only. */
  navCollapsed: boolean;
  /**
   * Screens hidden from the left nav. A hide-set (not a visible-list) so
   * screens added in future app versions default to visible. Persisted as
   * plain ids; the renderer sanitizes on use (drops unknown ids, never hides
   * 'now-playing'). Nav-only — hidden screens stay fully reachable via their
   * keyboard shortcut and the command palette.
   */
  navHidden: string[];
  /**
   * Nav tools hidden from the left nav's pinned bottom cluster (Commands,
   * Mini player). A hide-set (not a visible-list) so tools added in future app
   * versions default to visible. Persisted as plain ids; the renderer sanitizes
   * on use (drops unknown ids). Separate from navHidden — tool ids and screen
   * ids are different id-spaces. Nav-only: Commands stays on the palette
   * shortcut, the mini player stays in the palette and the View menu.
   */
  navHiddenTools: string[];
  /**
   * The user's own nav-rail order — screen ids, top to bottom. `[]` means the
   * registry's curated default, which is what almost everyone keeps.
   *
   * An ORDER, unlike navHidden's hide-set, can't default-by-omission, so the
   * sanitizer carries the rule instead: an id missing from a stored order is
   * inserted at its REGISTRY position, never appended. That is what stops a
   * screen added in a future version from landing below Device for everyone
   * who has ever touched this list. Hidden screens keep their slot here —
   * hidden means decluttered, not deleted, and unhiding restores position.
   *
   * Nav-rail screens only: the pinned bottom cluster (Commands, Mini player,
   * Settings) is fixed. KEYS DO NOT TRAVEL WITH POSITION — see the registry
   * header in lib/screens.ts.
   */
  navOrder: string[];
  /** Auto-scroll to the current queue row / playing preset. */
  followQueue: boolean;
  followPresets: boolean;
  /** Per-screen cards ⇄ rows layout. Card sizing shares the presetCard* settings. */
  queueLayout: QueueLayout;
  presetsLayout: ScreenLayout;
  libraryLayout: ScreenLayout;
  /** Album-grid sort in the Library (tracks always sort by track number). */
  librarySort: "server" | "title" | "artist" | "year";
  librarySortReversed: boolean;
  /**
   * VIEW DEFAULTS PERSIST (ruled 2026-08-06): a control that shapes how a
   * screen presents — sort, partition, layout, a hide-this-kind toggle — is
   * the user naming their preferred default view, so it lives here. What
   * stays session-only is workspace state: filter text, selections, scroll,
   * queries. The five below joined under that ruling; anything similar added
   * later belongs here too.
   */
  /** Albums lens sort (the native album grid above keeps librarySort). */
  lensAlbumsSort: "title" | "artist" | "year" | "dr" | "lastPlayed" | "plays";
  lensAlbumsSortReversed: boolean;
  /** Artists lens: hide artists that only have loose tracks. */
  lensArtistsAlbumsOnly: boolean;
  /** Albums lens partition: everything, artist albums only, or compilations only. */
  lensAlbumsKind: "all" | "albums" | "compilations";
  /** Tracks lens sort — the third lens (2026-09-01), every track across the
   *  ready indexes; DR sorts newest-analysis-first once the sweep has run. */
  lensTracksSort:
    "title" | "artist" | "album" | "year" | "duration" | "dr" | "lastPlayed" | "plays";
  lensTracksSortReversed: boolean;
  playlistsSort: "updated" | "created" | "played" | "name" | "length";
  playlistsSortReversed: boolean;
  /** Favorites kind partition (All / Stations / Albums / Tracks). */
  favoritesKind: "all" | "station" | "album" | "track";
  searchSort: "relevance" | "name";
  searchSortReversed: boolean;
  /**
   * Unified search: hidden result categories, plain ids sanitized on use
   * (the navHidden pattern). null = never customized — the screen derives
   * the default from navHidden (a screen hidden from the rail starts hidden
   * in search); an array is the user's explicit chip choice and wins.
   */
  searchHidden: string[] | null;
  /** Remembered sleep-timer action (pause vs standby). The countdown itself is not persisted. */
  sleepAction: SleepAction;
  /** Recently Played: collapse continuous sessions (radio/AirPlay/…) to one row, vs a row per song. */
  recentsGrouped: boolean;
  /** Motion effects (hover growth, eqbars, smooth scrolling). */
  motion: MotionMode;
  /** Check GitHub releases for a newer version on launch and every few hours. */
  updateCheck: boolean;
  /** Lyrics panel on Now Playing — fetches from LRCLIB on demand when opened. */
  /**
   * Waveforms drawn from each track's audio file, read from the local media
   * server (EXPERIMENT, 0.7 exploration). The master is the fetch off-switch;
   * the seek-bar sub-toggle exists because restyling permanent chrome is a
   * different question from wanting waveform information (the tray-icon
   * precedent); displayWaveform is display mode's own in-mode button.
   */
  waveforms: boolean;
  waveformSeekBar: boolean;
  waveformNowPlaying: boolean;
  displayWaveform: boolean;
  /** EVIDENCE, not preference: flips true the first time an analysis is
   *  served (stored or read back) and never clears. The playback bar's
   *  taller geometry keys on the setting AND this — a household with no
   *  local media server never pays 16px for a waveform it can't have. A
   *  settings flag rather than a cache probe, so Clear cached lookups
   *  can't shrink the bar. */
  waveformSeen: boolean;
  lyrics: boolean;
  /** Inline flavor: current synced line under the Now Playing track details. */
  lyricsLine: boolean;
  /** Current synced line in full-screen display mode (toggled from its chrome). */
  displayLyrics: boolean;
  /** The listening record: a local, append-only play log (history/<year>.jsonl
   *  in userData). On by default — a diary can't be backfilled. */
  listeningRecord: boolean;
  /** The record's READING surfaces (0.8.0): last played in album headers, play
   *  counts and the Played filter in the Library, the resume offer on Now
   *  Playing. Off hides them all; the record itself keeps logging. */
  showListeningHistory: boolean;
  /** Scrobble listens to ListenBrainz (needs a user token; radio is never scrobbled). */
  lbEnabled: boolean;
  /** ListenBrainz user token, from listenbrainz.org/settings. Stored locally. */
  lbToken: string;
  /** Artist bio panel on Now Playing (MusicBrainz + Wikipedia, on demand). */
  artistInfo: boolean;
  /** Fill covers the media server doesn't have (MusicBrainz identifies the
   *  album, the Cover Art Archive supplies the image). Its own switch,
   *  independent of the context panel — the user's call, 2026-08-24. */
  albumArtLookup: boolean;
  /**
   * Look stations up in the radio-browser.info directory. OFF means the app
   * never contacts it — not from the Radio screen, not from unified search,
   * not from an agent. Favorited stations still play: a favorite carries its
   * own stream URL and needs no directory at all.
   */
  radioDirectory: boolean;
  /** Scheduled actions (alarms) — fire only while the app is running. */
  schedules: Schedule[];
  /** Countdown sleep timers ramp the volume down before firing (pre-amp mode only). */
  sleepFade: boolean;
  /**
   * Per-preset volume overrides (feature 10): recalling the preset through
   * TastyTunes also sets this volume. Keyed via presetVolumeKey (device udn +
   * preset id) so multi-streamer homes never cross-apply.
   */
  presetVolumes: Record<string, number>;
  /**
   * queueContentHash of the queue at save time for queue presets saved
   * through this app, keyed via presetVolumeKey(udn, slot). Lets the
   * Presets screen recognize a saved queue exactly (all tracks, in order)
   * even when the recall happened elsewhere or before this launch. Local to
   * this machine; presets saved by other controllers have no entry and fall
   * back to collage-fingerprint matching.
   */
  queueSignatures: Record<string, string>;
  /** MCP server for local AI agents. */
  mcp: McpSettings;
  /** Last-visited Settings tab (id from the Settings screen's tab rail). */
  /** Media indexes build/rebuild themselves (off = only from the Libraries buttons). */
  mediaIndexAuto: boolean;
  settingsTab: string;
  /**
   * Last-visited tray-panel tab. Remembered across opens on the same
   * precedent as `settingsTab` — you reach for the same one repeatedly, and
   * re-picking it every time is friction the panel can't afford at its size.
   *
   * Overridden by a heuristic, not a knob: opening on Queue with nothing
   * playing is an empty box, so an idle streamer opens on Presets.
   */
  trayTab: string;
  /**
   * Tray-panel list density: `detailed` carries album art and an artist line,
   * `compressed` is one line per row with no art — roughly double the rows in
   * the same space.
   *
   * WHY THIS IS SEPARATE FROM THE MAIN WINDOW'S LAYOUT SETTINGS, and the rule
   * for anything added later: **preferences travel between surfaces, fit does
   * not.** `followQueue` ("should the list chase the music?") is a preference —
   * it means the same thing in both places, so the panel honours the app's
   * setting rather than growing its own. Density is a question about how much
   * fits in a 380px window, which has no bearing on a 1180px one; sharing it
   * would force one answer onto two very different surfaces. The design
   * already applied this rule once, ruling that the panel must not inherit
   * `presetCardSize`/`presetGap`.
   */
  trayRowDensity: "detailed" | "compressed";
  /** Tray-panel presets: art tiles or rows. Separate from `presetsLayout` for
   *  the same reason as the density above — it's fit, not preference. */
  trayPresetsLayout: ScreenLayout;
  /** Last-selected diagnostics-drawer tab (smoip | requests). */
  diagnosticsTab: string;
  /** Last-selected Device-screen tab (tabs appear only on tone-capable streamers). */
  deviceTab: "streamer" | "sources" | "tone";
  /** Width (px) of the Now Playing drawers (lyrics/artist), drag-resizable. */
  panelWidth: number;
  /** Remembered mini-player window position. */
  miniBounds: { x: number; y: number } | null;
  /** Remembered main-window bounds — reopened at this size/position. */
  mainBounds: { x: number; y: number; width: number; height: number } | null;
  /**
   * Artist per device preset, keyed by presetVolumeKey(udn, presetId) —
   * recorded when TastyTunes saves an album/track preset from the Library.
   * LOCAL-ONLY: /presets/list carries NO artist field and firmware-derived
   * names are just the album title, so this is what lets the Presets filter
   * match "iron" against an Iron Maiden album preset. Presets saved by other
   * controllers have no entry (nothing to record from). Same lifecycle trade
   * as presetVolumes: entries are keyed by slot and not remapped on
   * move/delete.
   */
  presetArtists: Record<string, string>;
  /**
   * User-saved EQ gain-sets (7 gains, dB). LOCAL by design: the firmware has
   * no preset storage — the official app's EQ presets are client-side too
   * (confirmed on the wire: tapping/saving one produces zero device traffic),
   * so its presets and ours can't see each other. Applying = one multi-band
   * user_eq_bands frame.
   */
  eqPresets: Array<{ name: string; gains: number[] }>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  lastHost: null,
  knownDevices: [],
  mediaKeys: true,
  volumeLimitPercent: null,
  notifications: true,
  // ON by default (user call, 2026-08-03, once the panel feature-completed):
  // the panel is the app's reach-without-a-window face, and a default-off
  // switch buried mid-list meant most installs would never meet it. Existing
  // installs that TOUCHED the toggle keep their stored value; only settings
  // files without the key pick up the new default.
  tray: true,
  trayCloseNoticeShown: false,
  theme: "dark",
  displayFont: "fraunces",
  ambientArt: "all",
  ambientCoverage: "window",
  vignette: true,
  accentFollowsArt: false,
  presetCardSize: 160,
  presetGap: 12,
  presetFillRows: true,
  nowPlayingAlignH: "left",
  nowPlayingAlignV: "top",
  navCollapsed: false,
  navHidden: [],
  navHiddenTools: [],
  navOrder: [],
  followQueue: true,
  followPresets: false,
  queueLayout: "rows",
  presetsLayout: "cards",
  libraryLayout: "cards",
  librarySort: "server",
  librarySortReversed: false,
  lensAlbumsSort: "title",
  lensAlbumsSortReversed: false,
  lensArtistsAlbumsOnly: false,
  lensAlbumsKind: "all",
  lensTracksSort: "title",
  lensTracksSortReversed: false,
  playlistsSort: "updated",
  playlistsSortReversed: false,
  favoritesKind: "all",
  searchSort: "relevance",
  searchSortReversed: false,
  searchHidden: null,
  sleepAction: "standby",
  recentsGrouped: true,
  motion: "system",
  updateCheck: true,
  waveforms: true,
  waveformSeekBar: true,
  waveformNowPlaying: false,
  displayWaveform: true,
  waveformSeen: false,
  lyrics: true,
  lyricsLine: true,
  displayLyrics: true,
  listeningRecord: true,
  showListeningHistory: true,
  lbEnabled: false,
  lbToken: "",
  artistInfo: true,
  albumArtLookup: true,
  radioDirectory: true,
  schedules: [],
  sleepFade: true,
  presetVolumes: {},
  queueSignatures: {},
  mcp: {
    enabled: false,
    bind: "localhost",
    port: 8555,
    disabledClusters: [],
    enabledClusters: [],
    disabledTools: [],
  },
  mediaIndexAuto: true,
  settingsTab: "appearance",
  trayTab: "queue",
  // COMPRESSED by default (user call, 2026-08-03): the panel's job is a
  // glance's worth of list in a corner of the screen, and the flat rows fit
  // ~11 where the floating ones fit 6. The detailed skin stays one chip away.
  trayRowDensity: "compressed",
  trayPresetsLayout: "cards",
  diagnosticsTab: "smoip",
  deviceTab: "streamer",
  panelWidth: 400,
  miniBounds: null,
  mainBounds: null,
  presetArtists: {},
  eqPresets: [],
};

// ------------------------------------------------------------------ media browser

export interface MediaServerInfo {
  udn: string;
  name: string;
  model: string | null;
  /** True when this "server" is the connected streamer itself (USB storage). */
  isStreamer: boolean;
  /** True when the server answers ContentDirectory Search (non-empty SearchCaps). */
  searchable: boolean;
}

/**
 * Per-server state of the local media index — a REBUILDABLE CACHE of server
 * metadata (never user data): built by crawling ContentDirectory, invalidated
 * wholesale when the server's SystemUpdateID moves (or a TTL passes), gone
 * without loss if deleted. Searchable servers crawl via paged Search
 * (seconds); Browse-only servers build on demand by walking containers.
 */
export interface MediaIndexStatus {
  udn: string;
  serverName: string;
  /** 'failed': the last build produced nothing (the server refused Search AND Browse — offline, or mid-scan); `failure` says why. */
  state: "none" | "building" | "ready" | "failed";
  failure?: string;
  strategy: "search" | "browse" | null;
  tracks: number;
  albums: number;
  artists: number;
  builtAt: number | null;
  updateId: number | null;
  profile?: MediaServerProfile;
}

export interface MediaNode {
  id: string;
  parentId: string | null;
  title: string;
  upnpClass: string;
  isContainer: boolean;
  artUrl: string | null;
  artist: string | null;
  album: string | null;
  /** Release year, when the server sends dc:date (Asset does; the USB server doesn't). */
  year: string | null;
  trackNumber: number | null;
  durationSecs: number | null;
  /**
   * upnp:originalDiscNumber / originalDiscCount, when the server sends them
   * (Asset does; it ALSO packs disc×100+track into originalTrackNumber — 212
   * for disc 2 track 12 — so read positions through trackPosition()).
   */
  discNumber?: number;
  discCount?: number;
  /**
   * The audio format of the primary <res>, when the server describes it
   * (DLNA attributes: protocolInfo mime, bitsPerSample, sampleFrequency,
   * bitrate in BYTES/s per the UPnP spec, size). Asset sends all of them
   * (live 2026-08-15); the streamer's USB server sends duration only.
   */
  format?: MediaFormat;
  /**
   * upnp:genre values, when the server sends any (multi-valued — real tags
   * repeat the element). Raw tagger data: case-normalize before faceting.
   * Absent (not empty) when the server offers none.
   */
  genre?: string[];
  /**
   * The album artist, when the server says so (Asset: upnp:artist
   * role="AlbumArtist"). Absent otherwise. This — not `artist` — is what
   * decides whether a track belongs to an album under an artist: a featured
   * track's `artist` reads "Daft Punk; Julian Casablancas" while its album
   * artist is Daft Punk.
   */
  albumArtist?: string;
  /**
   * The performers as separate names, when `artist` packs more than one
   * ("A; B" → ["A", "B"]). Absent for a single performer — read identity
   * through a helper that falls back to [artist], never off this alone.
   */
  artists?: string[];
  /**
   * upnp:artist role="Composer", split on "; " (Asset: "Thomas Bangalter;
   * Guy-Manuel de Homem-Christo"). Not performers — never an artist row;
   * searchable, and an album that shares one composer says so in its facts.
   */
  composers?: string[];
  /**
   * Which server this node came from — stamped ONLY on cross-server search
   * results, where nodes from several servers share a listing. Everywhere
   * else the screen's own server context applies and these stay absent.
   */
  serverUdn?: string;
  serverName?: string;
}

export interface MediaFormat {
  /** Codec label from the mime type: FLAC, MP3, AAC, ALAC, WAV, PCM, AIFF, WMA, OGG, Opus, DSD — or the bare subtype. */
  codec: string;
  bits?: number;
  /** Sample rate in Hz. */
  rate?: number;
  /** Stream bitrate in kbps (the spec's bytes/s ×8 /1000). */
  kbps?: number;
  sizeBytes?: number;
  channels?: number;
}

/**
 * The codecs whose bit depth is meaningful (a lossy stream has a bitrate, not
 * a word length). ONE list (2026-08-16): the parser consults it to decide
 * whether bitsPerSample is stored at all, and formatLabel to decide whether
 * to say "16/44.1" or "320 kbps" — two copies once disagreed only by luck.
 */
export const LOSSLESS_CODECS: ReadonlySet<string> = new Set([
  "FLAC",
  "WAV",
  "PCM",
  "AIFF",
  "ALAC",
  "DSD",
  "APE",
  "WV",
]);
const LOSSLESS = LOSSLESS_CODECS;

/**
 * Hi-res, ONE definition (2026-08-16): above CD-class — more than 16 bits or
 * more than 48 kHz (48 k counts as CD-class, not hi-res) — or MQA. The Now
 * Playing signal lamp, the library's album summary and the MCP list_albums
 * filter all ask this; the lamp once carried MQA and the summary did not.
 */
export const HIRES_BITS_ABOVE = 16;
export const HIRES_RATE_ABOVE = 48_000;
export function isHiRes(f: {
  bits?: number | null;
  rate?: number | null;
  mqa?: string | null;
}): boolean {
  return (
    (f.bits ?? 0) > HIRES_BITS_ABOVE ||
    (f.rate ?? 0) > HIRES_RATE_ABOVE ||
    (f.mqa != null && f.mqa !== "none")
  );
}

/** "FLAC · 16/44.1" for lossless (bits/kHz), "MP3 · 320 kbps" for lossy; degrades to what is known. */
export function formatLabel(f: MediaFormat | undefined | null): string | null {
  if (!f) return null;
  const khz = f.rate ? `${(f.rate / 1000).toFixed(f.rate % 1000 === 0 ? 0 : 1)}` : null;
  if (LOSSLESS.has(f.codec)) {
    const detail =
      f.bits && khz ? `${f.bits}/${khz}` : khz ? `${khz} kHz` : f.bits ? `${f.bits}-bit` : null;
    return detail ? `${f.codec} · ${detail}` : f.codec;
  }
  return f.kbps ? `${f.codec} · ${f.kbps} kbps` : f.codec;
}

/**
 * An album's format at a glance: the label every track shares, or the one
 * MOST tracks share (then the odd ones out get their own note); nothing
 * when formats are genuinely mixed or unknown. Returned alongside the
 * per-track notes so a header and its rows can never disagree.
 */
export function albumFormat(tracks: ReadonlyArray<Pick<MediaNode, "format">>): {
  label: string | null;
  /** For each input track, the note a row should carry — null when it matches the headline. */
  notes: (string | null)[];
} {
  const labels = tracks.map((t) => formatLabel(t.format));
  const counts = new Map<string, number>();
  for (const l of labels) if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  if (counts.size === 0) return { label: null, notes: labels.map(() => null) };
  const [top, n] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
  const known = labels.filter(Boolean).length;
  // THE PREDOMINANT FORMAT HEADLINES when at least half the tracks share it,
  // and every other track says what IT is; with no predominant format the
  // headline is "mixed formats" and every track says. The user's ruling
  // (2026-08-16, after a stricter odd-one-out cut hid information they
  // wanted): the point of the row notes is to SEE the exceptions, however
  // many there are.
  if (counts.size > 1 && n * 2 < known)
    return { label: "mixed formats", notes: labels.map((l) => l ?? null) };
  return { label: top, notes: labels.map((l) => (l && l !== top ? l : null)) };
}

/**
 * How a track row names its performers INSIDE AN ALBUM under its artist:
 * the album artist, then the guests as "feat." — "Daft Punk feat. Julian
 * Casablancas". Anywhere else (search, queue, a compilation) the raw packed
 * string is the honest thing to show, so this returns it unchanged unless
 * the album artist is among the performers and there are others.
 */
export function performerLine(
  n: Pick<MediaNode, "artist" | "artists" | "albumArtist">,
  albumArtist: string | null | undefined,
): string | null {
  const names = trackArtists(n);
  if (!albumArtist || names.length < 2) return n.artist;
  const key = albumArtist.trim().toLowerCase();
  const lead = names.find((x) => x.trim().toLowerCase() === key);
  if (!lead) return n.artist;
  const guests = names.filter((x) => x !== lead);
  return guests.length > 0 ? `${lead} feat. ${guests.join(", ")}` : n.artist;
}

const VARIOUS = /^(various(\s+artists?)?|va|v\.a\.|verschiedene(\s+interpreten)?|divers)$/i;

/**
 * Is this album a COMPILATION? Named so by its album artist ("Various
 * Artists" and friends), or — when the tracks are known — credited to an
 * album artist none of its performers is (a soundtrack under a label name);
 * an album whose guests join its own artist ("Daft Punk feat. …") is NOT.
 */
export function isCompilation(
  album: Pick<MediaNode, "artist">,
  tracks?: ReadonlyArray<Pick<MediaNode, "artist" | "artists" | "albumArtist">>,
): boolean {
  const owner = album.artist?.trim() ?? "";
  if (VARIOUS.test(owner)) return true;
  if (!tracks || tracks.length < 2 || !owner) return false;
  const key = owner.toLowerCase();
  const performerSets = tracks.map((t) => trackArtists(t).map((x) => x.trim().toLowerCase()));
  const anyOwner = performerSets.some((set) => set.includes(key));
  const distinct = new Set(performerSets.map((set) => set.join("|"))).size;
  return !anyOwner && distinct >= 2;
}

/** The composers every track shares (order of first appearance), or [] when they differ or are unknown. */
export function albumComposers(tracks: ReadonlyArray<Pick<MediaNode, "composers">>): string[] {
  const known = tracks.filter((t) => t.composers && t.composers.length > 0);
  if (known.length === 0 || known.length < tracks.length) return [];
  const first = known[0].composers!.map((x) => x.trim().toLowerCase());
  const same = known.every((t) => {
    const c = t.composers!.map((x) => x.trim().toLowerCase());
    return c.length === first.length && c.every((x) => first.includes(x));
  });
  return same ? known[0].composers! : [];
}

/**
 * The tracks that belong to an album, from an index pool: same title on the
 * same server, credited to the album's artist (trackInAlbumOf), and — when
 * the pool holds TWIN EDITIONS (same title, same artist) — sharing the
 * album's art. In album order. THE one derivation of "an album's tracks"
 * that both the Info modal and MCP use; the Artists lens computes the same
 * rule over its memoized map (S13/S16 pin it).
 */
export function albumTracksOf(
  album: Pick<MediaNode, "title" | "artist" | "artUrl">,
  pool: {
    albums: ReadonlyArray<Pick<MediaNode, "title" | "artist">>;
    tracks: ReadonlyArray<MediaNode>;
  },
): MediaNode[] {
  const title = album.title.trim().toLowerCase();
  const owner = (album.artist ?? "").trim().toLowerCase();
  const twins =
    pool.albums.filter(
      (a) =>
        a.title.trim().toLowerCase() === title && (a.artist ?? "").trim().toLowerCase() === owner,
    ).length > 1;
  return orderTracks(
    pool.tracks.filter(
      (t) =>
        (t.album ?? "").trim().toLowerCase() === title &&
        trackInAlbumOf(t, album.artist ?? null) &&
        (!twins || sameArt(t.artUrl, album.artUrl)),
    ),
  );
}

/**
 * The album node a pool track belongs to — the inverse of albumTracksOf:
 * same title, and the track's performers pass trackInAlbumOf against the
 * album's credited artist (twin editions fall back to the first match).
 * Null when the index holds no such album. Content identity, no network:
 * the Tracks lens's album link enters the album through the lens crumb.
 */
export function albumOfTrack(
  track: Pick<MediaNode, "album" | "artist" | "artists" | "albumArtist">,
  pool: { albums: MediaNode[] },
): MediaNode | null {
  if (!track.album) return null;
  const want = track.album.trim().toLowerCase();
  const matches = pool.albums.filter((a) => a.title.trim().toLowerCase() === want);
  return matches.find((a) => trackInAlbumOf(track, a.artist)) ?? matches[0] ?? null;
}

/**
 * Order an album's tracks: by (disc, position) when that key is UNIQUE across
 * the list, otherwise the LISTING ORDER stands. minidlna (rig-verified
 * 2026-08-16) sends no disc number and per-disc track numbers — a two-disc
 * set is 1, 2, 1, 2 — but its Browse order is disc-then-track; sorting by the
 * numbers alone interleaved the discs (d1t1, d2t1, d1t2, …). Duplicate keys
 * mean the numbers cannot say more than the server already has; the sort
 * cannot improve on the listing and can only scramble it. Every sort of an
 * album's tracks goes through here (leaf, lens, albumTracksOf).
 */
export function orderTracks<T extends Pick<MediaNode, "trackNumber" | "discNumber">>(
  tracks: ReadonlyArray<T>,
): T[] {
  const seen = new Set<string>();
  let repeats = false;
  for (const t of tracks) {
    const pos = trackPosition(t);
    if (pos == null) continue;
    const key = `${t.discNumber ?? 1}:${pos}`;
    if (seen.has(key)) {
      repeats = true;
      break;
    }
    seen.add(key);
  }
  if (!repeats) return [...tracks].sort(compareTrackOrder);
  // Repeats: the listing order stands ONLY when it reads as discs — ascending
  // runs, each restarting lower than the last position (Browse of a minidlna
  // or MinimServer album). A search-built index lists by title (Gerbera,
  // Minim) and that order says nothing about discs; sort by position then,
  // interleaved but ordered (survey 2026-08-17: OKNOTOK came out alphabetical).
  const positions = tracks.map(trackPosition);
  let ascendingRuns = true;
  let restarts = 0;
  for (let i = 1; i < positions.length; i++) {
    const a = positions[i - 1];
    const b = positions[i];
    if (a == null || b == null) continue;
    if (b < a) restarts++;
    else if (b === a) {
      ascendingRuns = false;
      break;
    }
  }
  if (ascendingRuns && restarts > 0 && restarts < positions.length / 2) return [...tracks];
  return [...tracks].sort(compareTrackOrder);
}

/** Everything an album's tracks add up to — the leaf's facts, the lens heading, the Info modal and MCP all read this. */
export function albumSummary(
  album: Pick<MediaNode, "artist">,
  tracks: MediaNode[],
): {
  tracks: number;
  discs: number;
  runtimeSecs: number;
  sizeBytes: number;
  format: string | null;
  /** how many tracks differ from the format headline */
  formatOdd: number;
  hires: boolean;
  composers: string[];
  isCompilation: boolean;
} {
  const fmt = albumFormat(tracks);
  return {
    tracks: tracks.length,
    discs: discGroups(tracks).filter((g) => g.disc != null).length || (tracks.length > 0 ? 1 : 0),
    runtimeSecs: tracks.reduce((a, t) => a + (t.durationSecs ?? 0), 0),
    sizeBytes: tracks.reduce((a, t) => a + (t.format?.sizeBytes ?? 0), 0),
    format: fmt.label,
    formatOdd: fmt.notes.filter(Boolean).length,
    hires: tracks.some((t) => t.format != null && isHiRes(t.format)),
    composers: albumComposers(tracks),
    isCompilation: isCompilation(album, tracks),
  };
}

/** 940 MB, 1.2 GB — for album/playlist size sums. */
export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * EXPERIMENT (0.7 exploration): a track's stored audio analysis — what the
 * renderer's decode persists (main's disk cache) and every waveform surface
 * rereads. Envelopes are quantized to integer thousandths of full scale so
 * the cache file stays humane; dB stats ride as null when non-finite
 * (silence), since JSON has no -Infinity.
 */
export interface AudioAnalysis {
  /** TT dynamic range integer; <= 0 means "no honest number". */
  dr: number;
  peakDb: number | null;
  rmsDb: number | null;
  crestDb: number | null;
  /** Peak/RMS envelopes at capture resolution, amplitude x1000 (0..1000). */
  peakQ: number[];
  rmsQ: number[];
}

/** An album's recorded DR — written ONLY when every track measured (the TT
 *  album value is the mean of ALL its tracks; a partial read has no honest
 *  number). `tracks` lets surfaces retire a stale entry when the album's
 *  track count changes. */
export interface AlbumDr {
  dr: number;
  tracks: number;
  analyzedAt: number;
}

/** Content identity for stored audio analysis — the trackInfo key precedent
 *  (artist|album|title, lowercased) plus duration, so a remaster sharing
 *  its name doesn't inherit another edition's waveform. Identity, not
 *  location: server object ids churn on rescans. */
export function audioAnalysisKey(
  t: Pick<MediaNode, "title" | "artist" | "album" | "durationSecs">,
): string {
  return `${t.artist ?? ""}|${t.album ?? ""}|${t.title}|${t.durationSecs ?? ""}`.toLowerCase();
}

/** Album identity for the DR map — artist|title, lowercased. */
export function albumDrKey(a: Pick<MediaNode, "title" | "artist">): string {
  return `${a.artist ?? ""}|${a.title}`.toLowerCase();
}

/**
 * A track's performers as separate names — the ONLY way to ask "who is on
 * this track": `artists` when the server packed several, else the single
 * `artist`. Never key identity on the packed string ("A; B" is two people).
 */
export function trackArtists(n: Pick<MediaNode, "artist" | "artists">): string[] {
  if (n.artists && n.artists.length > 0) return n.artists;
  return n.artist ? [n.artist] : [];
}

/**
 * Does this track belong to an album credited to `albumArtist`? The album
 * artist wins when the server sends one (a featured track's performers are
 * "Daft Punk; Julian Casablancas"; its album is Daft Punk's); otherwise any
 * performer matching counts (servers without an AlbumArtist role — the USB
 * stick); a track with no artist at all is not held against the album.
 */
export function trackInAlbumOf(
  n: Pick<MediaNode, "artist" | "artists" | "albumArtist">,
  albumArtist: string | null,
): boolean {
  if (albumArtist == null) return true;
  const want = albumArtist.trim().toLowerCase();
  if (n.albumArtist) return n.albumArtist.trim().toLowerCase() === want;
  const names = trackArtists(n);
  if (names.length === 0) return true;
  return names.some((a) => a.trim().toLowerCase() === want);
}

/**
 * The track's position WITHIN ITS DISC — the number a row should show. Asset
 * packs disc×100+track into originalTrackNumber for multi-disc albums (live:
 * 113 = disc 1 track 13, 212 = disc 2 track 12); when the disc number agrees
 * with that packing the hundreds are the disc, not the track. Servers that
 * send a plain track number alongside the disc are returned as-is.
 */
export function trackPosition(n: Pick<MediaNode, "trackNumber" | "discNumber">): number | null {
  const t = n.trackNumber;
  if (t == null) return null;
  if (n.discNumber != null && t >= 100 && Math.floor(t / 100) === n.discNumber) return t % 100;
  return t;
}

/**
 * Album order: disc, then position. Tracks without a disc sort as disc 1;
 * without a position they keep their listing order after the numbered ones.
 */
export function compareTrackOrder(
  a: Pick<MediaNode, "trackNumber" | "discNumber">,
  b: Pick<MediaNode, "trackNumber" | "discNumber">,
): number {
  const da = a.discNumber ?? 1;
  const db = b.discNumber ?? 1;
  if (da !== db) return da - db;
  const pa = trackPosition(a);
  const pb = trackPosition(b);
  if (pa == null && pb == null) return 0;
  if (pa == null) return 1;
  if (pb == null) return -1;
  return pa - pb;
}

/** Consecutive runs of one disc, for the quiet "Disc N" dividers — only when the list actually spans discs. */
export function discGroups<T extends Pick<MediaNode, "discNumber">>(
  tracks: T[],
): { disc: number | null; tracks: T[] }[] {
  // "no disc" IS disc 1 (that is how compareTrackOrder sorts it too) — an
  // album where some tracks say disc 1 and the rest say nothing is one disc,
  // not an alternation of dividers (two GUNSHIP editions, 2026-08-16)
  const discs = new Set(tracks.map((t) => t.discNumber ?? 1));
  if (discs.size < 2) return [{ disc: null, tracks }];
  const out: { disc: number | null; tracks: T[] }[] = [];
  for (const t of tracks) {
    const d = t.discNumber ?? 1;
    const last = out[out.length - 1];
    if (last && last.disc === d) last.tracks.push(t);
    else out.push({ disc: d, tracks: [t] });
  }
  return out;
}

/**
 * Same album ART? The way to tell two EDITIONS of one album apart when
 * title, artist and year all agree (16/44.1 and 24/44.1 GUNSHIP folders,
 * 2026-08-16): Asset stamps every track with its album folder's cover id,
 * so a track belongs to the edition whose art it shares. Compared without
 * the size query, unknown on either side counts as a match.
 */
export function sameArt(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  return a.split("?")[0] === b.split("?")[0];
}

/** An artist as the library knows them — the Info modal's artist page and MCP's get_media_info share it. */
export interface ArtistSummary {
  name: string;
  /** Albums credited to them (album artist), newest first, with a format headline when known. */
  albums: {
    title: string;
    year: string | null;
    format: string | null;
    tracks: number;
    objectId: string;
    serverUdn?: string;
  }[];
  /** Tracks they perform on (headliner or guest). */
  trackCount: number;
  /** Tracks they GUEST on — performer, but not the album artist. */
  guestOn: { title: string; album: string | null; albumArtist: string | null; objectId: string }[];
  /** Tracks they wrote (role=Composer). */
  composed: { title: string; album: string | null; objectId: string }[];
  /** Genres across their albums, most common first. */
  genres: string[];
  /** Earliest and latest album year. */
  years: [string, string] | null;
  artUrl: string | null;
}

/**
 * Everything the index says about an artist by NAME (case-insensitive) — the
 * album-artist credits, the performer credits (guest spots included), the
 * composer credits. Names that exist only as credits (a featured singer with
 * no albums of their own) get a page too.
 */
export function artistSummary(
  name: string,
  pool: { albums: ReadonlyArray<MediaNode>; tracks: ReadonlyArray<MediaNode> },
): ArtistSummary {
  const key = name.trim().toLowerCase();
  const same = (v: string | null | undefined): boolean => (v ?? "").trim().toLowerCase() === key;
  const albums = pool.albums
    .filter((a) => same(a.artist))
    .map((a) => {
      const tracks = albumTracksOf(a, pool);
      return {
        title: a.title,
        year: a.year,
        format: albumFormat(tracks).label,
        tracks: tracks.length,
        objectId: a.id,
        ...(a.serverUdn ? { serverUdn: a.serverUdn } : {}),
        artUrl: a.artUrl,
      };
    })
    .sort((x, y) => (y.year ?? "").localeCompare(x.year ?? "") || x.title.localeCompare(y.title));
  const performs = pool.tracks.filter((t) => trackArtists(t).some(same));
  // a GUEST spot is a track on someone else's album: the album owner (the
  // track's album artist, else the album's credited artist) is known and is
  // not them — a loose single with no album is simply theirs
  const ownerOf = (t: MediaNode): string | null =>
    t.albumArtist ??
    pool.albums.find(
      (a) => t.album && a.title.trim().toLowerCase() === t.album.trim().toLowerCase(),
    )?.artist ??
    null;
  const guestOn = performs
    .filter((t) => {
      const owner = ownerOf(t);
      return owner != null && !same(owner);
    })
    .map((t) => ({
      title: t.title,
      album: t.album ?? null,
      albumArtist: ownerOf(t),
      objectId: t.id,
    }));
  const composed = pool.tracks
    .filter((t) => (t.composers ?? []).some(same))
    .map((t) => ({ title: t.title, album: t.album ?? null, objectId: t.id }));
  const genreCount = new Map<string, number>();
  for (const a of pool.albums.filter((x) => same(x.artist)))
    for (const g of a.genre ?? []) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
  const genres = [...genreCount.entries()].sort((x, y) => y[1] - x[1]).map(([g]) => g);
  const yearsList = albums
    .map((a) => a.year)
    .filter((y): y is string => !!y)
    .sort();
  return {
    name: name.trim(),
    albums: albums.map(({ artUrl: _a, ...rest }) => rest),
    trackCount: performs.length,
    guestOn,
    composed,
    genres,
    years: yearsList.length > 0 ? [yearsList[0], yearsList[yearsList.length - 1]] : null,
    artUrl: albums.find((a) => a.artUrl)?.artUrl ?? null,
  };
}

/**
 * What the Info modal is looking at: a node, plus — for an album — the tracks
 * the caller already knows belong to it (the album leaf's listing, or the
 * lens's index-matched tracks), so runtime/size/format/composers can be
 * summed without a lookup. `serverName` names the source when the node
 * itself isn't stamped (screen-scoped browsing).
 */
export interface MediaInfoTarget {
  node: MediaNode;
  tracks?: MediaNode[];
  serverName?: string | null;
  /** The server the node lives on when the node itself carries no stamp —
   *  browse listings hold theirs in the screen's state (nodeUdn), and the
   *  Info modal's waveform needs it to find the file. */
  serverUdn?: string | null;
  /** A caveat to show — e.g. the item wasn't found in any library index and this is only what the list knew. */
  note?: string | null;
  /** For an artist: their library page (albums, credits) — from artistSummary. */
  artist?: ArtistSummary;
  /** For what is playing NOW: the stream as the streamer reports it (source-agnostic — radio, AirPlay, local media alike). */
  stream?: StreamInfo;
  /** What the index learned about the server this came from — how it was crawled and every reconciliation that changed something. */
  serverProfile?: MediaServerProfile;
}

/**
 * The stream the streamer is decoding right now — its own account, distinct
 * from the library's file facts (a transcode, or Asset's decoded reporting,
 * makes the two differ, and that is worth seeing).
 */
export interface StreamInfo {
  source: string | null;
  playbackSource: string | null;
  playbackClass: string | null;
  codec: string | null;
  sampleFormat: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  /** bits per second, as the streamer reports it */
  bitrate: number | null;
  encoding: string | null;
  lossless: boolean | null;
  mqa: string | null;
  station: string | null;
  radioId: string | null;
  queuePosition: number | null;
  queueLength: number | null;
  presettable: boolean | null;
  /** the transport verbs this source honours (now_playing.controls) */
  controls: string[];
}

/**
 * What a MediaRef surface (queue, favorites, playlists, recents, search)
 * can say about a thing when asking main to find its node: identity hints
 * first (server + object id), then content (title / artist / album).
 */
export interface MediaInfoQuery {
  kind: "track" | "album" | "artist";
  title: string;
  artist?: string | null;
  album?: string | null;
  serverUdn?: string | null;
  objectId?: string | null;
}

/** One server's slice of a cross-server (all ready indexes) search. */
export interface MediaSearchAllGroup {
  udn: string;
  serverName: string;
  /** Matches, each stamped with serverUdn/serverName. */
  items: MediaNode[];
  total: number;
}

/**
 * What the index learned about a server while crawling it — the SHAPE of its
 * answers, never its brand (2026-08-17, the UPnP server survey). Chosen from
 * what the server just did, recorded so the app can say why something looks
 * the way it does (Info › Source, MCP list_media_servers) instead of leaving
 * the user to guess: "albums synthesised from tracks — this server exposes no
 * album containers" is a sentence, not a bug report.
 */
export interface MediaServerProfile {
  /** How the index was built: paged Search, or a walk of the container tree. */
  strategy: "search" | "browse";
  /** Where the albums came from: the class search, a browse walk (search yielded no albums), or built from the tracks (no album containers anywhere). */
  albumsFrom: "search" | "browse" | "tracks";
  /** How the server answered class searches: leaf classes ('leaf'), everything as the bare base class ('generalized' — Asset), nothing derived from the asked class ('unhonoured' — Emby, UMS), or no Search at all ('unavailable'). */
  classSearch: "leaf" | "generalized" | "unhonoured" | "unavailable";
  /** Every reconciliation that changed something — FACTS, not prose: the words are made at display time by describeProfileNote(), so wording can change without re-indexing. */
  notes: ProfileNote[];
}

/** One thing the index did while reading a server. `count` where it applies. */
export type ProfileNote =
  | { kind: "navigation-entries-left-out"; what: "albums" | "artists" | "tracks"; count: number }
  | { kind: "albums-found-by-browsing"; count: number }
  | { kind: "albums-assembled-from-tracks"; count: number }
  | { kind: "duplicate-albums-merged"; count: number }
  | { kind: "years-from-tracks"; count: number }
  | { kind: "search-failed-browsed-instead" }
  | { kind: "search-paged-smaller" }
  | { kind: "browse-capped"; count: number };

/**
 * The words for a ProfileNote — user-facing (Info › Source, MCP), plain, no
 * UPnP vocabulary; a note exists only when something needed handling, so a
 * healthy server shows none. One home for the wording (renderer and MCP both
 * call this); changing a sentence here needs no re-index.
 */
export function describeProfileNote(note: ProfileNote): string {
  const n = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`;
  switch (note.kind) {
    case "navigation-entries-left-out":
      return note.what === "albums"
        ? `${n(note.count, "entry", "entries")} the server adds for navigation (such as “- All Albums -”) left out of the albums`
        : note.what === "artists"
          ? `${n(note.count, "navigation entry", "navigation entries")} left out of the artists`
          : `${n(note.count, "entry", "entries")} that ${note.count === 1 ? "was" : "were"} not a track left out of the tracks`;
    case "albums-found-by-browsing":
      return `the server's album search returned nothing — ${n(note.count, "album was", "albums were")} found by browsing instead`;
    case "albums-assembled-from-tracks":
      return `this server doesn't list albums — TastyTunes assembled them from its ${n(note.count, "track", "tracks")}`;
    case "duplicate-albums-merged":
      return `${n(note.count, "duplicate album entry", "duplicate album entries")} merged — the server lists some albums more than once`;
    case "years-from-tracks":
      return note.count === 1
        ? "1 album with no year took the year from its tracks"
        : `${note.count} albums with no year took the year from their tracks`;
    case "search-failed-browsed-instead":
      return "the server's search failed — the library was indexed by browsing instead";
    case "search-paged-smaller":
      return "the server's search failed on large pages — read in smaller pages instead";
    case "browse-capped":
      return `browsing stopped after ${note.count} folders — a very large library may be only partly indexed`;
  }
}

/** One READY index's full pools, nodes stamped — the library lenses' feedstock. */
export interface MediaIndexPools {
  udn: string;
  serverName: string;
  albums: MediaNode[];
  artists: MediaNode[];
  tracks: MediaNode[];
  profile?: MediaServerProfile;
}

/** Queue-write verbs of /smoip/queue/add (semantics per vibin's reverse-engineering). */
export type MediaQueueAction = "REPLACE" | "APPEND" | "PLAY_NEXT" | "PLAY_NOW" | "PLAY_FROM_HERE";

// ------------------------------------------------------------------ internet radio

/** A station from the radio-browser.info community directory (main-process lookup). */
export interface RadioStation {
  uuid: string;
  name: string;
  /** The playable stream URL (radio-browser's url_resolved — playlists unwrapped). */
  url: string;
  favicon: string | null;
  homepage: string | null;
  /** Comma-separated tag list as the directory provides it. */
  tags: string;
  country: string;
  codec: string;
  /** kbps; 0 = unknown. */
  bitrate: number;
}
