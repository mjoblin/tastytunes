import { BookmarkPlus } from 'lucide-react'
import type { RadioStation } from '@shared/ipc'
import { MediaRow } from '@/components/MediaRow'
import { RowAction } from '@/components/RowAction'
import { RowHeart } from '@/components/RowHeart'

/**
 * One internet-radio station, as a row.
 *
 * Lifted out of RadioScreen 2026-07-25 so the unified Search screen shows
 * stations EXACTLY as the Radio screen does — a station carries metadata no
 * generic result row keeps (tags, country, codec/bitrate) and one action no
 * other row has (save-to-preset, offered only while PLAYING — the firmware
 * saves what's audible). Since the consistency pass it RENDERS through
 * MediaRow like every other floating row; this wrapper only maps station data
 * onto it.
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
  /** Save-to-preset, offered on the PLAYING row. Optional: search omits it —
   *  the save panel belongs to the Radio screen, which has the room for it —
   *  and the button simply isn't rendered rather than wired to a no-op. */
  onSave?(x: number, y: number): void
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
    <MediaRow
      attrs={{ 'data-radio-row': station.name }}
      title={station.name}
      subtitle={subtitle || undefined}
      artUrl={station.favicon}
      kind="station"
      playing={playing}
      tuning={tuning}
      onClick={() => onPlay()}
      meta={
        tuning ? (
          <span data-radio-tuning className="text-gold/80 motion-safe:animate-pulse">
            tuning in…
          </span>
        ) : quality ? (
          <span className="font-mono text-[10.5px] text-faint/70 uppercase">{quality}</span>
        ) : undefined
      }
      actions={
        <>
          <RowHeart favorited={favorited} held={false} onHeart={onHeart} />
          {playing && onSave && (
            <RowAction
              icon={BookmarkPlus}
              label="Save station to preset"
              tip="Save station to preset"
              pinned
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                onSave(r.left, r.bottom + 6)
              }}
            />
          )}
        </>
      }
    />
  )
}
