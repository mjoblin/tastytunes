import { cx } from '@/lib/format'

/** Gold playing bars (queue idiom); frozen while paused. Rendered only on the
 *  current item, so always gold. */
export function Eqbars({ playing }: { playing: boolean }): React.JSX.Element {
  return (
    <span className={cx('eqbars text-gold', !playing && 'paused')}>
      <span style={{ height: 6 }} />
      <span style={{ height: 10 }} />
      <span style={{ height: 5 }} />
    </span>
  )
}
