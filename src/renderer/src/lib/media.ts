import type { MediaNode } from '@shared/ipc'

// UPnP class-shape helpers shared by the Library screen and its cards.

export const isAlbumClass = (c: string): boolean => c.includes('musicAlbum')
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
