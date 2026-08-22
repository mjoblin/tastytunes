import type { MediaIndexPools, MediaNode } from '@shared/model'
import type { QueueListItemMetadata } from '@shared/smoip'
import { trackMatchesEntry } from '@/lib/playingEntry'

/**
 * WHAT A QUEUE ENTRY'S ROW SHOWS FOR "ARTIST".
 *
 * The streamer stores a queue entry's artist as the FIRST upnp:artist of the
 * DIDL it was queued with. Asset lists the AlbumArtist role first, minidlna
 * sends only the album artist, so on a compilation every row reads "Various
 * Artists" while the library (which reads the roles) knows each track's
 * performer — and Now Playing shows the performer from the file tags. Live,
 * 2026-08-21: all 38 entries of a compilation queue.
 *
 * So rows ask the ready indexes: the entry is matched to a library track by
 * the same rule the playing-row highlight uses (title, album, duration,
 * artist identity), and ONLY when the entry's artist is that track's album
 * artist and the track names a different performer does the row show the
 * performer instead. Servers that already store the performer (Gerbera,
 * Emby, Jellyfin, UMS, MinimServer, Plex) never trip the rule; a track not
 * in any index, or matched to tracks that disagree, keeps the device's
 * string. DISPLAY ONLY — `metadata.artist` stays what the device said for
 * everything that is identity (the queue↔playlist content hash, restore,
 * favorites), or a saved playlist would stop recognising itself in the queue.
 */
export type TrackIndex = Map<string, MediaNode[]>

export function buildTrackIndex(pools: MediaIndexPools[] | null): TrackIndex {
  const index: TrackIndex = new Map()
  for (const pool of pools ?? []) {
    for (const n of pool.tracks) {
      const list = index.get(n.title)
      if (list) list.push(n)
      else index.set(n.title, [n])
    }
  }
  return index
}

const indexCache = new WeakMap<MediaIndexPools[], TrackIndex>()
const EMPTY: TrackIndex = new Map()

/** One title-keyed index per pools snapshot, shared by every row. */
export function trackIndexFor(pools: MediaIndexPools[] | null): TrackIndex {
  if (pools == null) return EMPTY
  let index = indexCache.get(pools)
  if (!index) {
    index = buildTrackIndex(pools)
    indexCache.set(pools, index)
  }
  return index
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The performer to show for a queue entry, or null when the device's string stands. */
export function performerFor(
  md: QueueListItemMetadata | null | undefined,
  index: TrackIndex
): string | null {
  if (!md?.title || !md.artist) return null
  const found = new Set<string>()
  for (const n of index.get(md.title) ?? []) {
    if (!trackMatchesEntry(n, md)) continue
    if (!n.albumArtist || !sameName(n.albumArtist, md.artist)) continue
    if (!n.artist || sameName(n.artist, md.artist)) continue
    found.add(n.artist)
  }
  return found.size === 1 ? [...found][0] : null
}
