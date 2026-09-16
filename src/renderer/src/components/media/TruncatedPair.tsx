import { cx } from "@/lib/format";

/**
 * ONE LINE, TWO TONES, honest ellipses (2026-09-05). A bright title and a dim
 * artist that share one truncating element get their "…" drawn in the
 * element's own color — the bright one — even when the text it stands in for
 * is the dim artist (the tray's "MJ Lende…" read brighter than "MJ Lenderman").
 * Here each tone truncates itself: the lead keeps its full width while it fits
 * (and clips, in its own color, only when it alone overflows), the sub takes
 * what is left and gives way first. The tray's rows and the Stats top lists
 * read through it; any "title · sub" on one line should.
 */
export function TruncatedPair({
  lead,
  sub,
  sep = " · ",
  leadClass,
  subClass,
  className,
}: {
  lead: React.ReactNode;
  sub?: React.ReactNode;
  sep?: string;
  leadClass?: string;
  subClass?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cx("flex min-w-0 items-baseline", className)} data-truncated-pair>
      <span className={cx("min-w-0 max-w-full shrink-0 truncate", leadClass)}>{lead}</span>
      {sub != null && sub !== "" && (
        <span className={cx("min-w-0 flex-1 truncate", subClass)}>
          {sep}
          {sub}
        </span>
      )}
    </span>
  );
}
