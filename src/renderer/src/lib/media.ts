import type { MediaNode } from '@shared/model'

// UPnP class-shape helpers shared by the Library screen and its cards.

export const isAlbumClass = (c: string): boolean => c.includes('musicAlbum')

/**
 * The library taxonomy, and it is CLOSED AT THREE by construction.
 *
 * A media index only ever holds artists, albums and tracks, whichever way it
 * was built: the searchable crawl issues exactly three UPnP Searches
 * (object.container.album / object.container.person / object.item.audioItem),
 * and the browse crawl walks every container but FILES only musicAlbum,
 * person and audioItem — genre containers, storage folders and playlist
 * containers are traversed and dropped. A server may expose more; the index
 * has already decided not to keep it.
 *
 * So this is the one classifier for the one taxonomy. It used to be spelled
 * twice — matchesKind here, a second copy in the search screen with a
 * different artist predicate and an 'Album' fallback that would silently
 * mislabel anything unexpected. Two spellings of one closed set is how the
 * two drift.
 */
export type MediaKind = 'artist' | 'album' | 'track'

/** A PERSON container (musicArtist etc.) — strictly class-matched, so a plain
 *  storage folder can never pass. The index's artist pool is built on this. */
export const isArtistClass = (c: string): boolean => c.includes('person') || c.includes('Artist')

export const mediaKind = (upnpClass: string, isContainer: boolean): MediaKind =>
  !isContainer
    ? 'track'
    : isAlbumClass(upnpClass)
      ? 'album'
      : isArtistClass(upnpClass)
        ? 'artist'
        : // Unreachable from an index (see above); an unfiled container is far
          // likelier to be album-shaped than a person, so this is the safe read.
          'album'
export const isEntityClass = (c: string): boolean =>
  c.includes('musicAlbum') || c.includes('musicArtist') || c.includes('audioItem')

/**
 * Server action-furniture: Asset (and kin) inject rows like " [All Tracks]" /
 * " [Shuffle Tracks]" beside an artist's albums — redundant re-listings of the
 * siblings around them, not places to go. The signature is a DIDL shape, not a
 * server name: bracketed title on an entirely bare `object.container`, sitting
 * beside properly-classed media entities. The sibling guard keeps this general —
 * in a pure folder tree (USB drives, filesystem servers) nothing is
 * entity-classed, so a real folder named "[Bootlegs]" survives. Navigation
 * views with class leaves (Asset's `object.container.person` letter tiles,
 * "[All Artists]") also survive — they lead somewhere and already render muted.
 */
export const stripFurniture = (list: MediaNode[]): MediaNode[] => {
  if (!list.some((n) => isEntityClass(n.upnpClass))) return list
  return list.filter(
    (n) =>
      !(n.isContainer && n.upnpClass === 'object.container' && /^\[.+\]$/.test(n.title.trim()))
  )
}

/**
 * Mute navigation-folder art so it recedes into the app's palette; real
 * media art stays vivid. The upnp:class LEAF is the discriminator (probed
 * against Asset): real entities carry the specific classes musicAlbum /
 * musicArtist, while virtual views and folders are bare containers — Asset's
 * letter tiles are `object.container.person` (no .musicArtist leaf).
 */
export const isMutedArt = (node: MediaNode): boolean =>
  !isAlbumClass(node.upnpClass) && !node.upnpClass.includes('musicArtist')
