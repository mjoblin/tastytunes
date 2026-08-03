import { Disc3, Folder, ListOrdered, Music, Radio, RadioTower, UserRound } from 'lucide-react'
import { ArtImage } from '@/components/media/ArtImage'
import { cx } from '@/lib/format'

/**
 * THE row-scale artwork thumb. One size (h-10 — the 44px grid column's inset),
 * one ring, one fallback icon per media kind, everywhere a row shows art.
 *
 * Before this existed there were fourteen hand-rolled copies at three sizes
 * (h-9 / h-10 / h-11) with per-screen fallback icons — drift with no meaning.
 * Cards keep their own aspect-square fill; the playlist rail keeps its
 * ArtStack; everything ROW-shaped renders art through here.
 */
export type MediaArtKind =
  | 'track'
  | 'album'
  | 'artist'
  | 'station'
  | 'playlist'
  | 'preset'
  | 'folder'

const FALLBACK: Record<MediaArtKind, React.ComponentType<{ size?: number; className?: string }>> = {
  track: Music,
  album: Disc3,
  artist: UserRound,
  station: RadioTower,
  playlist: ListOrdered,
  preset: Radio,
  folder: Folder
}

/**
 * The two sanctioned art sizes, and there are only two.
 *
 * `row` (40px) is the app's row scale — the 44px grid column's inset — and is
 * what every window-sized surface uses. `dense` (32px) exists for the tray
 * panel ONLY: at 380px wide, 40px art plus two lines of text is a 48px row,
 * and the panel's whole job is fitting a glance's worth of list into a corner
 * of the screen. Amended 2026-07-28 at the user's call; before that the size
 * was a single constant, and the suite still asserts it is one of exactly
 * these two rather than whatever a caller fancied.
 */
export type MediaArtSize = 'row' | 'dense'

export function MediaArt({
  src,
  kind = 'track',
  icon,
  size = 'row',
  className
}: {
  src?: string | null
  kind?: MediaArtKind
  /** Escape hatch for a caller with a better icon than the kind default. */
  icon?: React.ComponentType<{ size?: number; className?: string }>
  size?: MediaArtSize
  className?: string
}): React.JSX.Element {
  const Fallback = icon ?? FALLBACK[kind]
  return (
    <div
      data-media-art
      data-art-size={size}
      className={cx(
        'shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center',
        size === 'dense' ? 'h-8 w-8' : 'h-10 w-10',
        className
      )}
    >
      <ArtImage
        src={src ?? null}
        lazy
        fallback={<Fallback size={size === 'dense' ? 14 : 16} className="text-faint" />}
      />
    </div>
  )
}
