import { cx } from "@/lib/format";

export interface SegmentedOption<T> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  /** Optional hover tooltip (uses the app's data-tip treatment). */
  tip?: string;
  /** Rendered but inert and dimmed (e.g. a server with no matches) — the
   *  option stays visible so the control never reshapes with the data. */
  disabled?: boolean;
  /** How many the option holds, in a pill after its label (Choose a picture's sources); null
   *  while it is still being asked, the pill's room kept so the tab keeps its width. */
  count?: number | null;
}

/**
 * A pill segmented toggle: the active option is filled gold, the rest are
 * translucent (bg-panel/70) so the backdrop shows through — matching the
 * queue/preset follow buttons. Generic over the option value type.
 */
export function Segmented<T extends string | number | boolean>({
  value,
  options,
  onChange,
  className,
  modal = false,
}: {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange(value: T): void;
  className?: string;
  /** Inside a ModalShell: no hover transition (its note: they crawl over the blur). */
  modal?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cx("no-drag flex h-8 rounded-lg ring-1 ring-edge bg-panel/70 p-0.5", className)}
    >
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          aria-pressed={value === opt.value}
          onClick={() => {
            if (!opt.disabled) onChange(opt.value);
          }}
          aria-disabled={opt.disabled || undefined}
          data-tip={opt.tip}
          className={cx(
            "flex items-center gap-1.5 px-3 rounded-md text-[12px]",
            !modal && "transition-colors",
            opt.tip && "tip-top",
            opt.disabled
              ? "text-faint opacity-50 cursor-default"
              : value === opt.value
                ? "bg-golddim text-gold"
                : "text-dim hover:text-ink",
          )}
        >
          {opt.icon}
          {opt.label}
          {opt.count !== undefined && (
            // a pill with room for two digits, the count centred in it: a count arriving, or
            // reaching ten, never widens the tab (his look, 2026-10-30); hidden while it is asked
            <span
              data-segment-count
              className={cx(
                "grid h-4 min-w-[1.375rem] place-items-center rounded-full px-1 text-[10.5px] leading-none tabular-nums",
                opt.count == null && "invisible",
                value === opt.value ? "bg-gold/15 text-gold" : "bg-veil text-faint",
              )}
            >
              {opt.count ?? ""}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
