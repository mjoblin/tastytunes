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

export function MediaArt({
  src,
  kind = 'track',
  icon,
  className
}: {
  src?: string | null
  kind?: MediaArtKind
  /** Escape hatch for a caller with a better icon than the kind default. */
  icon?: React.ComponentType<{ size?: number; className?: string }>
  className?: string
}): React.JSX.Element {
  const Fallback = icon ?? FALLBACK[kind]
  return (
    <div
      data-media-art
      className={cx(
        'h-10 w-10 shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center',
        className
      )}
    >
      <ArtImage src={src ?? null} lazy fallback={<Fallback size={16} className="text-faint" />} />
    </div>
  )
}
