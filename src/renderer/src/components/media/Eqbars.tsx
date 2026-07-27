import { cx } from '@/lib/format'

/**
 * The gold playing bars — one copy of the "this is what's sounding" idiom
 * (queue rows, library cards, presets, recents). Frozen while not audibly
 * playing; `dim` marks a row whose source isn't the audible one (queue rows
 * while another source plays) — dimmed and frozen.
 */
export function Eqbars({ playing, dim = false }: { playing: boolean; dim?: boolean }): React.JSX.Element {
  return (
    <span
      className={cx('eqbars shrink-0', dim ? 'text-faint' : 'text-gold', (!playing || dim) && 'paused')}
    >
      <span style={{ height: 6 }} />
      <span style={{ height: 10 }} />
      <span style={{ height: 5 }} />
    </span>
  )
}
