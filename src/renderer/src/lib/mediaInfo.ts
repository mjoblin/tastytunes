import type { MediaInfoQuery, MediaNode } from '@shared/model'
import { tt } from '@/api'
import { useStore } from '@/store'
import type { MediaRef } from '@/lib/mediaRef'

/**
 * Open the Info modal for something a LIST holds only a ref to (a queue row,
 * favorite, playlist item, recent, search hit). Main looks the node up —
 * index by id, then by content, then live BrowseMetadata — and the modal
 * shows everything found; when nothing is found it still opens on what the
 * list knew, with a caveat, rather than doing nothing. Stations have no
 * library node and are left to their own surfaces.
 */
export async function openInfoForRef(ref: MediaRef): Promise<void> {
  if (ref.kind === 'station') return
  const query: MediaInfoQuery = {
    kind: ref.kind,
    title: ref.title,
    artist: ref.artist,
    album: ref.album,
    serverUdn: ref.serverUdn,
    objectId: ref.objectId
  }
  const set = useStore.getState().setMediaInfo
  // open at once on what we have — the lookup usually lands within a beat and
  // simply enriches it (a click that does nothing while a live browse runs
  // reads as a dead menu item)
  const stub: MediaNode = {
    id: ref.objectId ?? '',
    parentId: null,
    title: ref.title,
    upnpClass:
      ref.kind === 'album'
        ? 'object.container.album.musicAlbum'
        : ref.kind === 'artist'
          ? 'object.container.person.musicArtist'
          : 'object.item.audioItem.musicTrack',
    isContainer: ref.kind !== 'track',
    artUrl: ref.artUrl,
    artist: ref.artist,
    album: ref.album,
    year: null,
    trackNumber: null,
    durationSecs: ref.durationSecs,
    ...(ref.serverUdn ? { serverUdn: ref.serverUdn } : {}),
    ...(ref.serverName ? { serverName: ref.serverName } : {})
  }
  set({ node: stub, serverName: ref.serverName ?? null, note: 'Looking it up in the library…' })
  let found = null
  try {
    found = await tt.mediaNodeInfo(query)
  } catch {
    found = null
  }
  // only replace if the user hasn't closed (or opened something else) meanwhile
  const current = useStore.getState().mediaInfo
  if (!current || current.node !== stub) return
  if (found) set({ ...found, serverName: found.serverName ?? ref.serverName ?? null })
  else set({ node: stub, serverName: ref.serverName ?? null, note: 'Not found in any library index — showing what this list knows.' })
}
