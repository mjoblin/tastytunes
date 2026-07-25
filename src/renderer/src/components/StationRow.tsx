import { BookmarkPlus, Heart, Loader2, RadioTower } from 'lucide-react'
import type { RadioStation } from '@shared/ipc'
import { ArtImage } from '@/components/ArtImage'
import { Eqbars } from '@/components/Eqbars'
import { cx } from '@/lib/format'

/**
 * One internet-radio station, as a row.
 *
 * Lifted out of RadioScreen 2026-07-25 so the unified Search screen shows
 * stations EXACTLY as the Radio screen does — a station carries metadata no
 * generic result row would keep (tags, country, codec/bitrate, favicon) and
 * actions no other result has (heart, save-to-preset). Re-implementing it for
 * search is precisely how the two would drift apart.
 *
 * Purely presentational: every action arrives as a prop, so the caller owns
 * "playing", the tuning state, and what a heart means.
 */
export function StationRow({
  station,
  playing,
  tuning,
  favorited,
  onHeart,
  onPlay,
  onSave
}: {
  station: RadioStation
  playing: boolean
  /** Play sent, stream not landed yet — the row pre-glows and spins. */
  tuning: boolean
  favorited: boolean
  onHeart(): void
  onPlay(): void
  onSave(x: number, y: number): void
}): React.JSX.Element {
  const tags = station.tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ')
  const subtitle = [tags, station.country].filter(Boolean).join(' — ')
  const quality = [station.codec, station.bitrate > 0 ? `${station.bitrate}k` : null]
    .filter(Boolean)
    .join(' ')
  return (
    <div
      data-radio-row
      onClick={onPlay}
      className={cx(
        'group flex items-center gap-4 rounded-xl px-3 py-2.5 cursor-pointer transition-colors',
        playing
          ? 'row-playing bg-gold/10'
          : tuning
            ? 'ring-1 ring-gold/40 bg-golddim/40' // half-lit: on its way to playing
            : 'ring-1 ring-edge bg-panel/60 hover:bg-raised/70 hover:ring-edge2'
      )}
    >
      <div className="h-11 w-11 shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        <ArtImage
          src={station.favicon}
          lazy
          fallback={<RadioTower size={17} className="text-faint" />}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cx(
            'flex items-center gap-2 text-[13.5px] truncate',
            playing ? 'text-gold' : tuning ? 'text-gold/80' : 'text-ink'
          )}
        >
          {playing && <Eqbars playing />}
          {tuning && <Loader2 size={13} className="spin shrink-0" />}
          <span className="truncate">{station.name}</span>
        </div>
        {subtitle && <div className="text-[12px] text-dim truncate">{subtitle}</div>}
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {tuning ? (
          <span data-radio-tuning className="text-[10.5px] text-gold/80 motion-safe:animate-pulse">
            tuning in…
          </span>
        ) : (
          quality && (
            <span className="text-[10.5px] text-faint/70 font-mono uppercase">{quality}</span>
          )
        )}
        {/* hover-revealed unless favorited — presence + gold IS the state */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onHeart()
          }}
          data-tip={favorited ? 'Remove from favorites' : 'Add to favorites'}
          aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
          data-station-heart={favorited ? 'on' : 'off'}
          className={cx(
            'p-1.5 rounded-full transition-all motion-safe:active:scale-90',
            favorited
              ? 'text-gold hover:text-ink'
              : 'text-dim hover:text-ink hover:bg-veil2 opacity-0 group-hover:opacity-100'
          )}
        >
          <Heart size={15} fill={favorited ? 'currentColor' : 'none'} />
        </button>
        {playing && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              onSave(r.left, r.bottom + 6)
            }}
            data-tip="Save station to preset"
            aria-label="Save station to preset"
            className="p-1.5 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
          >
            <BookmarkPlus size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
