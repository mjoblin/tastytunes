// The user's own collections: the recently-played log, favorites and playlists, with the
// content identity that lets each survive a media server re-indexing (a favorite and a
// playlist entry key on the same lowercased fields, so the healing path is shared).

import type { ZonePlayState } from "../smoip";
import { contentRowsHash, isRadioMetadata, radioTrackTitle } from "../smoip";
import type { MediaNode } from "./media";
import { type CopyFacts, artAddress, artHostOf, contradicts, copiesOf, nodeFacts } from "./copies";

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
  /** The streamer that played it, by udn (0.8.0 on, additive; older entries carry none). */
  streamer?: string | null;
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
  /** WHICH COPY the heart is on (0.13.0, his call: each copy its own, across servers): its
   *  server and item at heart time, or the moment it was made. It makes favoriteKey one per
   *  copy, so two copies of one album can each be hearted. Absent on hearts from before, whose
   *  server, item, picture and length still say which copy they are (heartOf). */
  copy?: string;
  /** The copy's sample rate and bit depth at heart time (0.13.0), when it was known: what tells
   *  two copies on one server apart, and what the Favorites screen shows beside the name. */
  rate?: number | null;
  bits?: number | null;
}

export type Favorite = FavoriteStation | FavoriteMedia;

/** The content a favorite is of, with no copy: what two copies of one album share. Stations key
 *  on the URL; media on lowercased content fields, without the server. */
export function favoriteContentKey(
  f: Favorite | Pick<FavoriteMedia, "kind" | "title" | "artist" | "album">,
): string {
  const lc = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();
  if (f.kind === "station") return `station:${f.url}`;
  if (f.kind === "album") return `album:${lc(f.title)}:${lc(f.artist)}`;
  return `track:${lc(f.title)}:${lc(f.artist)}:${lc(f.album)}`;
}

/**
 * A favorite's identity: its content and, since 0.13.0, the copy it is on (FavoriteMedia.copy),
 * so the store keeps one per copy. Adds, removals and updates go by it; whether a thing is
 * hearted is heartOf's question, never a key compared with a payload's.
 */
export function favoriteKey(f: Favorite): string {
  const k = favoriteContentKey(f);
  return f.kind !== "station" && f.copy ? `${k}@${f.copy}` : k;
}

/** A new heart's copy mark: its server and item when it came from the library, else the moment
 *  it was made (one heart per copy, however the copy was named). */
export function copyMarkOf(
  f: Pick<FavoriteMedia, "serverUdn" | "objectId">,
  addedAt: number,
): string {
  return f.serverUdn && f.objectId ? `${f.serverUdn}|${f.objectId}` : `t${addedAt}`;
}

/** What a heart, or a thing that may be hearted, says about its copy (copies.ts). */
export function heartFacts(
  f: Pick<FavoriteMedia, "artUrl" | "serverUdn" | "durationSecs" | "rate" | "bits">,
): CopyFacts {
  return {
    art: artAddress(f.artUrl),
    server: f.serverUdn ?? null,
    host: artHostOf(f.artUrl),
    secs: f.durationSecs ?? null,
    rate: f.rate ?? null,
    bits: f.bits ?? null,
  };
}

/** A thing that may be hearted: its content, and what it says about its copy. */
export type HeartItem = Pick<
  FavoriteMedia,
  "kind" | "title" | "artist" | "album" | "artUrl" | "serverUdn" | "durationSecs" | "rate" | "bits"
>;

/** The library's albums and tracks by favorite content key, made on the first ask: the other
 *  copies a heart is told apart from (heartOf). */
export function heartPeersFrom(
  pools: ReadonlyArray<{ albums: readonly MediaNode[]; tracks: readonly MediaNode[] }>,
): (item: Pick<FavoriteMedia, "kind" | "title" | "artist" | "album">) => readonly MediaNode[] {
  let byKey: Map<string, MediaNode[]> | null = null;
  return (item) => {
    if (!byKey) {
      byKey = new Map();
      const add = (k: string, n: MediaNode): void => {
        const list = byKey?.get(k);
        if (list) list.push(n);
        else byKey?.set(k, [n]);
      };
      for (const g of pools) {
        for (const a of g.albums) add(favoriteContentKey({ ...a, kind: "album", album: null }), a);
        for (const t of g.tracks) add(favoriteContentKey({ ...t, kind: "track" }), t);
      }
    }
    return byKey.get(favoriteContentKey(item)) ?? [];
  };
}

/** The media favorites by content, made once per favorites list (the store hands out a new
 *  list on every change): a heart check is then one lookup, not a key made for every favorite. */
const contentMaps = new WeakMap<readonly Favorite[], Map<string, FavoriteMedia[]>>();
function byContent(favorites: readonly Favorite[]): Map<string, FavoriteMedia[]> {
  let m = contentMaps.get(favorites);
  if (!m) {
    m = new Map();
    for (const f of favorites) {
      if (f.kind === "station") continue;
      const k = favoriteContentKey(f);
      m.set(k, [...(m.get(k) ?? []), f]);
    }
    contentMaps.set(favorites, m);
  }
  return m;
}

/**
 * THE HEART A COPY CARRIES (0.13.0): of the favorites of the same content, the one whose facts
 * pick this copy out of the library's copies (`peers`: the library's albums or tracks of the same
 * content, the index's and the listing's; the item's own entry among them is recognized and
 * dropped). With no other copy known (the library not read here), a favorite of the same content
 * counts unless its facts contradict this copy's (another server, another length). A heart whose
 * copy has left the library lights every copy rather than none (copiesOf sets its facts aside).
 */
export function heartOf(
  item: HeartItem,
  favorites: readonly Favorite[],
  peers: ReadonlyArray<Pick<MediaNode, "artUrl" | "durationSecs" | "format" | "serverUdn">> = [],
): FavoriteMedia | null {
  const same = byContent(favorites).get(favoriteContentKey(item));
  if (!same) return null;
  const mine = heartFacts(item);
  const isMine = (f: CopyFacts): boolean =>
    f.server != null &&
    f.server === mine.server &&
    f.art === mine.art &&
    (f.secs == null || mine.secs == null || Math.abs(f.secs - mine.secs) < 1);
  const copies: Array<{ f: CopyFacts; mine: boolean }> = [{ f: mine, mine: true }];
  for (const p of peers) {
    const f = nodeFacts(p);
    if (!isMine(f)) copies.push({ f, mine: false });
  }
  for (const fav of same) {
    const want = heartFacts(fav);
    const hit =
      copies.length === 1
        ? !contradicts(want, mine)
        : copiesOf(want, copies, (c) => c.f).some((c) => c.mine);
    if (hit) return fav;
  }
  return null;
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
  /** The item's art URL as the streamer reports it: its host names the server
   *  that is playing it, preferred over index order when the same content sits
   *  on several servers (a copy on the streamer's USB stick, 2026-09-16). */
  artUrl?: string | null;
}

/** A picture read from an audio file's own tags (FLAC PICTURE, ID3 APIC),
 *  resized for display; width/height are the ORIGINAL picture's, so a surface
 *  can tell whether it beats the server's artwork. */
export interface EmbeddedArt {
  dataUrl: string;
  width: number;
  height: number;
}
/** What to read the picture from: a resolved library object, or a track by content. */
export type EmbeddedArtQuery = { serverUdn: string; objectId: string } | ContentRef;

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
