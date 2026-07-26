import type {
  ContentRef,
  Favorite,
  MediaNode,
  PlaylistItem,
  RecentTrack
} from '@shared/ipc'
import type { QueueListItem } from '@shared/smoip'
import type { NewFavorite } from '@/lib/favorites'
import { mediaKind } from '@/lib/media'

/**
 * THE one renderer-side currency for "a piece of media", whatever screen it
 * came from.
 *
 * The app holds five source shapes (MediaNode, QueueListItem.metadata,
 * Favorite, PlaylistItem, RecentTrack) and used to bridge them with four
 * ad-hoc converters scattered across screens — which is why every
 * cross-surface verb (heart, add-to-playlist, pivot) had to be re-plumbed per
 * screen. The converters now live HERE, in one file, and the shared verbs and
 * menu builders speak MediaRef only.
 *
 * The identity discipline is the app's standing one: CONTENT
 * (title/artist/album) is the durable key; serverUdn/objectId are healable
 * fast-path hints; stations key on their stream URL. Presets are deliberately
 * NOT in this currency — a preset is a device slot, not content.
 */
export interface MediaRef {
  kind: 'track' | 'album' | 'artist' | 'station'
  title: string
  artist: string | null
  album: string | null
  artUrl: string | null
  durationSecs: number | null
  /** Stations only — the stream URL (their identity). */
  url: string | null
  /** Fast-path hints; content re-resolves on a miss. */
  serverUdn: string | null
  serverName: string | null
  objectId: string | null
}

const base = {
  artist: null as string | null,
  album: null as string | null,
  artUrl: null as string | null,
  durationSecs: null as number | null,
  url: null as string | null,
  serverUdn: null as string | null,
  serverName: null as string | null,
  objectId: null as string | null
}

/** A library node (browse, search results, unified search's library group). */
export function fromNode(
  node: MediaNode,
  serverUdn?: string | null,
  serverName?: string | null
): MediaRef {
  return {
    ...base,
    kind: mediaKind(node.upnpClass, node.isContainer),
    title: node.title,
    artist: node.artist,
    album: node.album,
    artUrl: node.artUrl,
    durationSecs: node.durationSecs,
    serverUdn: node.serverUdn ?? serverUdn ?? null,
    serverName: node.serverName ?? serverName ?? null,
    objectId: node.id
  }
}

/** A queue row. Null when it has no content identity (no title) — same rule
 *  as the heart: an unidentifiable track can never be found again. */
export function fromQueueItem(item: QueueListItem): MediaRef | null {
  const md = item.metadata
  if (!md?.title) return null
  return {
    ...base,
    kind: 'track',
    title: md.title,
    artist: md.artist ?? null,
    album: md.album ?? null,
    artUrl: md.art_url ?? null,
    durationSecs: md.duration ?? null
    // no server/object hints: a queue id belongs to THIS queue, not the library
  }
}

export function fromFavorite(f: Favorite): MediaRef {
  if (f.kind === 'station') {
    return { ...base, kind: 'station', title: f.name, artUrl: f.favicon, url: f.url }
  }
  return {
    ...base,
    kind: f.kind,
    title: f.title,
    artist: f.artist,
    album: f.album,
    artUrl: f.artUrl,
    durationSecs: f.durationSecs ?? null,
    serverUdn: f.serverUdn,
    serverName: f.serverName,
    objectId: f.objectId
  }
}

export function fromPlaylistItem(it: PlaylistItem): MediaRef {
  return {
    ...base,
    kind: 'track',
    title: it.title,
    artist: it.artist,
    album: it.album,
    artUrl: it.artUrl,
    durationSecs: it.durationSecs ?? null,
    serverUdn: it.serverUdn,
    serverName: it.serverName,
    objectId: it.objectId
  }
}

/** A recently-played entry. Null for radio/sessions — no stream URL is stored,
 *  so there is no identity to act on (documented gap, not an oversight). */
export function fromRecent(e: RecentTrack): MediaRef | null {
  if (e.isRadio || e.title == null) return null
  return {
    ...base,
    kind: 'track',
    title: e.title,
    artist: e.artist,
    album: e.album,
    artUrl: e.artUrl
  }
}

// ------------------------------------------------------------- outbound shapes

/** The heart's shape. Null when the ref has no content identity to store. */
export function refToFavorite(ref: MediaRef): NewFavorite | null {
  if (ref.kind === 'station') {
    return ref.url
      ? { kind: 'station', name: ref.title, url: ref.url, favicon: ref.artUrl, radioBrowserUuid: null }
      : null
  }
  if (ref.kind === 'artist') return null // favorites key on album/track identity
  if (!ref.title || (ref.kind === 'track' && !ref.artist)) return null
  return {
    kind: ref.kind,
    title: ref.title,
    artist: ref.artist,
    album: ref.kind === 'track' ? ref.album : null,
    artUrl: ref.artUrl,
    serverUdn: ref.serverUdn,
    serverName: ref.serverName,
    objectId: ref.objectId,
    titlePath: null,
    durationSecs: ref.durationSecs
  }
}

export function refToPlaylistItem(ref: MediaRef): PlaylistItem {
  return {
    title: ref.title,
    artist: ref.artist,
    album: ref.album,
    artUrl: ref.artUrl,
    serverUdn: ref.serverUdn,
    serverName: ref.serverName,
    objectId: ref.objectId,
    durationSecs: ref.durationSecs
  }
}

export function refToContentRef(ref: MediaRef): ContentRef {
  return { title: ref.title, artist: ref.artist, album: ref.album }
}
