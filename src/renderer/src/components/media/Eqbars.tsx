import { cx } from '@/lib/format'
import { useStore } from '@/store'

/**
 * The gold playing bars — one copy of the "this is what's sounding" idiom
 * (queue rows, library rows/cards, presets, recents, the tray panel).
 *
 * PRESENCE is the caller's call: mount it where the CURRENT item is. MOTION is
 * decided here, once — the bars dance only while sound is actually coming out
 * (play state 'play'), and rest as the same glyph frozen at its staggered
 * heights while paused or buffering. Callers must never pass their own
 * audibility: the day each surface gated its own bars, the tray and the
 * floating rows kept dancing through a pause. `dim` marks a row whose source
 * isn't the audible one (queue rows parked under another source) — faint and
 * flattened, quietly set apart.
 */
export function Eqbars({ dim = false }: { dim?: boolean }): React.JSX.Element {
  const audible = useStore((s) => s.playState?.state === 'play')
  return (
    <span
      className={cx(
        'eqbars shrink-0',
        dim ? 'text-faint parked' : cx('text-gold', !audible && 'paused')
      )}
    >
      <span style={{ height: 6 }} />
      <span style={{ height: 10 }} />
      <span style={{ height: 5 }} />
    </span>
  )
}
