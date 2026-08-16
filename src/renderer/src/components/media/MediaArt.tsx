import { Disc3, Folder, ListOrdered, Music, Radio, RadioTower, UserRound } from 'lucide-react'
import { ArtImage } from '@/components/media/ArtImage'
import { cx } from '@/lib/format'
import { artUrlAt } from '@shared/artUrl'

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

/**
 * The fallback glyph per kind, EXPORTED so surfaces that don't render through
 * MediaArt still pick from the same set. The preset grid draws its art at card
 * scale with its own ArtImage, and used to hardcode `Radio` — which agreed
 * with this table by luck, until the tray panel guessed radio-vs-album for the
 * same presets and an input source came out as a disc in one window and a
 * radio in the other.
 */
export const MEDIA_ART_FALLBACK: Record<
  MediaArtKind,
  React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
> = {
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
 *
 * `card` FILLS its container — for tiles, where the art is the whole point.
 * It exists so a caller doesn't have to override the box with `h-full w-full`
 * and hope the class order goes its way, and so the FALLBACK GLYPH can scale
 * with it: a 16px row glyph marooned in a 112px tile is unreadable, which is
 * exactly how it shipped.
 */
export type MediaArtSize = 'row' | 'dense' | 'card'

/** Fallback glyph size per art size — the row sizes are thumb-scale, the card
 *  one is sized to be legible in a tile a third of the panel's width. */
const GLYPH: Record<MediaArtSize, number> = { row: 16, dense: 14, card: 28 }

/**
 * A big glyph needs a THINNER stroke, not the same one scaled up. Lucide's
 * default 2 is tuned for ~16px marks, where it's what makes them legible; at
 * 28px the same weight reads as a fat cartoon of the icon. The preset grid has
 * drawn its card-scale glyph at 1.2 since it was written, and shares this
 * constant so the two can't diverge again.
 */
export const CARD_GLYPH_STROKE = 1.2
const GLYPH_STROKE: Record<MediaArtSize, number> = { row: 2, dense: 2, card: CARD_GLYPH_STROKE }

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
  const Fallback = icon ?? MEDIA_ART_FALLBACK[kind]
  return (
    <div
      data-media-art
      data-art-size={size}
      className={cx(
        'shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center',
        size === 'card' ? 'h-full w-full' : size === 'dense' ? 'h-8 w-8' : 'h-10 w-10',
        className
      )}
    >
      <ArtImage
        // fetch at the drawn size — Asset serves the 1400px original for a
        // 40px thumb otherwise (shared/artUrl); cards fill up to ~240px tiles
        src={artUrlAt(src, size === 'card' ? 240 : size === 'dense' ? 32 : 40)}
        lazy
        fallback={
          <Fallback size={GLYPH[size]} strokeWidth={GLYPH_STROKE[size]} className="text-faint" />
        }
      />
    </div>
  )
}
