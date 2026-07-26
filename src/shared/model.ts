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

import type { ZonePlayState } from './smoip'
import { contentRowsHash, isRadioMetadata, radioTrackTitle } from './smoip'

// --------------------------------------------------------------- recently played

/**
 * One entry in the local recently-played log. The streamer keeps no history, so
 * the main process records each track it sees pass through /zone/play_state.
 * A bounded convenience log — explicitly not a database.
 */
export interface RecentTrack {
  /** When the track first appeared (ms epoch). */
  at: number
  /** Song title. Null for a songless state (radio that emits no song, or echoes its own name). */
  title: string | null
  artist: string | null
  album: string | null
  /** Set for internet radio — the station name (title then carries the song). */
  station: string | null
  artUrl: string | null
  /** Human source label (e.g. "Media Library", "AirPlay"), best-effort. */
  source: string | null
  /** SMOIP source id (e.g. "AIRPLAY", "IR", "MEDIA_PLAYER") — lets a row re-activate the source. */
  sourceId: string | null
  /** Queue item id at record time — lets a local row replay the track if it's still queued. */
  queueId: number | null
  isRadio: boolean
  /** Airable radio id, if any — used to match a station back to a preset for re-tuning. */
  radioId: number | null
  /**
   * Grouping key for continuous sessions. `radio:<station>` or `src:<sourceId>` for
   * sources whose now-playing song changes over one continuous session; null for a
   * discrete queued track, which never groups. Optional so pre-upgrade logs still load.
   */
  session: string | null
}

/**
 * Does a recently-played entry describe what /zone/play_state currently
 * reports? Mirrors the recording normalization in main/recents.ts (title-keyed;
 * a radio "song" that's absent or just echoes the station name is null), so the
 * Recently Played screen can mark its head entry live without drifting from how
 * entries were written.
 */
export function recentMatchesPlayState(e: RecentTrack, ps: ZonePlayState | null): boolean {
  const md = ps?.metadata
  if (!md) return false
  const eq = (a: string | null | undefined, b: string | null | undefined): boolean =>
    (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
  const isRadio = isRadioMetadata(md)
  if (e.isRadio !== isRadio) return false
  if (isRadio) {
    return eq(e.station, md.station) && eq(e.title, radioTrackTitle(md))
  }
  return e.title != null && eq(e.title, md.title)
}

// -------------------------------------------------------------------- favorites

/**
 * A favorited radio station. The stream URL is the identity — playing needs
 * no resolution at all (streamRadio with the stored url+name). The
 * radio-browser uuid is a recovery hint for URL rot: an on-demand re-lookup,
 * user-initiated only (never a click-ping — the privacy stance holds).
 */
export interface FavoriteStation {
  kind: 'station'
  addedAt: number
  name: string
  url: string
  favicon: string | null
  radioBrowserUuid: string | null
}

/**
 * A favorited album or track, keyed on CONTENT identity (title/artist/album)
 * — UPnP object ids rot, so `objectId` is only a fast-path hint and playing
 * falls back to a scoped library search. `serverUdn` is where it was hearted
 * (null for content-only entries from the Now Playing heart); `titlePath` is
 * the breadcrumb trail at heart time, feeding the browse re-walk.
 */
export interface FavoriteMedia {
  kind: 'album' | 'track'
  addedAt: number
  title: string
  artist: string | null
  /** Tracks only — the album the track belongs to. */
  album: string | null
  artUrl: string | null
  serverUdn: string | null
  serverName: string | null
  objectId: string | null
  titlePath: string[] | null
  /** Track length in seconds, captured at heart time (tracks; null when the
   *  source had none — favorites hearted before this field show blank). */
  durationSecs?: number | null
}

export type Favorite = FavoriteStation | FavoriteMedia

/**
 * Content identity — dedupe and heart-lit checks. Stations key on the URL;
 * media keys on lowercased content fields, deliberately WITHOUT the server
 * (the same album on two servers is the same music).
 */
export function favoriteKey(f: Favorite): string {
  const lc = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()
  if (f.kind === 'station') return `station:${f.url}`
  if (f.kind === 'album') return `album:${lc(f.title)}:${lc(f.artist)}`
  return `track:${lc(f.title)}:${lc(f.artist)}:${lc(f.album)}`
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
  title: string
  artist: string | null
  album: string | null
  artUrl: string | null
  serverUdn: string | null
  serverName: string | null
  /** Fast path only — may be stale, and is re-resolved from content on a miss. */
  objectId: string | null
  durationSecs?: number | null
}

/**
 * A track identified by CONTENT alone — the one currency both content-resolve
 * callers speak (a playlist entry whose objectId rotted, a removed queue row
 * that never had one). Defined once here so the two can't drift apart.
 */
export interface ContentRef {
  title: string
  artist?: string | null
  album?: string | null
}

/**
 * Queue undo is a re-resolve, not a rollback, so it reports which happened:
 * 'not-found' = the track couldn't be found on any server (say so — the user
 * is looking at a queue it didn't reappear in), 'failed' = the streamer or the
 * connection refused, 'ok' = it's back (possibly not in its old slot; see
 * queueRestore).
 */
export type QueueRestoreResult = 'ok' | 'not-found' | 'failed'

/** A stored, ordered collection of tracks. Bounded local JSON, no database. */
export interface Playlist {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** Last time this playlist was activated. Optional: playlists stored before
   *  this field existed simply have no last-played date to show. */
  lastPlayedAt?: number | null
  /** Titles the last activation couldn't find on any server. Kept so the gap
   *  is visible later, not just in the banner you dismissed at the time. */
  lastMissing?: string[]
  items: PlaylistItem[]
}

/**
 * Live progress of a playlist activation. Activation is inherently SLOW —
 * entries can only be added to the streamer's queue one at a time, and each
 * needs its media server's metadata first, so it is ~2 round-trips per track.
 * The renderer shows this; `missed` names what couldn't be found rather than
 * failing the whole run (partial activation is a normal outcome, not an error).
 */
export interface PlaylistActivation {
  playlistId: string
  name: string
  total: number
  done: number
  added: number
  missed: string[]
  cancelled: boolean
  finished: boolean
}

/**
 * Bounds that keep "a bounded local file" honest (favorites are unbounded
 * because they're small and deliberate; a playlist collection is neither).
 */
export const MAX_PLAYLISTS = 100
export const MAX_PLAYLIST_ITEMS = 500

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
  return contentRowsHash(items)
}

/**
 * Content identity for a playlist entry — deliberately the same shape as
 * favoriteKey's track form, so an item and a hearted track resolve the same
 * way and the healing path can be shared.
 */
export function playlistItemKey(i: PlaylistItem): string {
  const lc = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()
  return `track:${lc(i.title)}:${lc(i.artist)}:${lc(i.album)}`
}
