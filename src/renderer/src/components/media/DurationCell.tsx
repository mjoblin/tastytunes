import { cx, fmtTime } from "@/lib/format";

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
/** The wide cell's width: an album row's empty time cell keeps the same. */
export const DURATION_WIDE = "min-w-[7ch]";

export function DurationCell({
  secs,
  wide = false,
  className,
}: {
  secs: number | null | undefined;
  /** The Library's rows, where an album's running time ("1:12:45") shares the column with its
   *  tracks' times: room for the hours, so album and track rows end their buttons on one line. */
  wide?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      data-duration
      className={cx(
        "font-mono text-[11px] text-faint tabular-nums text-right shrink-0",
        wide ? DURATION_WIDE : "min-w-[5ch]",
        className,
      )}
    >
      {fmtTime(secs)}
    </span>
  );
}
