import { cx, fmtTime } from '@/lib/format'

/**
 * THE trailing duration cell for track rows.
 *
 * Two rules, both learned the hard way:
 * - RESERVED WIDTH (5ch, right-aligned, tabular digits): a missing duration
 *   must not collapse the column — rows that rendered '' let the heart drift
 *   to the edge and break the vertical line every other row holds.
 * - The placeholder comes from fmtTime ('–:––'): "length unknown" is an
 *   answer, and a quiet dash reads as a blank table cell rather than a hole.
 */
export function DurationCell({
  secs,
  className
}: {
  secs: number | null | undefined
  className?: string
}): React.JSX.Element {
  return (
    <span
      data-duration
      className={cx(
        'font-mono text-[11px] text-faint tabular-nums text-right min-w-[5ch] shrink-0',
        className
      )}
    >
      {fmtTime(secs)}
    </span>
  )
}
