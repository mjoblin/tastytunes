import { cx } from "@/lib/format";

/**
 * The floating multi-select bar every selection surface wears (the queue, the
 * Library's track lists, the lens's tracks column). Owns the structure so it
 * cannot drift: the toast entrance and popover surface (floating over the
 * list, never re-laying it out — a chord must not move the rows being
 * picked), the count in a fixed LEFT column, and the surface's verbs in
 * their own wrapping container beside it — a narrow surface wraps lines
 * under the first verb, never under the count — with Clear keeping the
 * right edge of its line. Verbs are the surface's own (children, built from
 * SelectionVerb); anchor geometry (insets, z) stays at the call site, the
 * chrome-kit rule.
 */
export function SelectionBar({
  count,
  onClear,
  className,
  children,
  ...rest
}: {
  count: number;
  onClear(): void;
  /** Anchor geometry only — e.g. "bottom-4 inset-x-6 z-30". */
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "children">): React.JSX.Element {
  return (
    <div
      data-selection-bar
      className={cx(
        "toast-in absolute flex items-start gap-3 rounded-xl ring-1 ring-edge2 bg-raised shadow-xl px-3 py-2 text-[12.5px]",
        className,
      )}
      {...rest}
    >
      <span className="shrink-0 py-px text-dim tabular-nums mt-[3px]">{count} selected</span>
      <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {children}
        <button
          onClick={onClear}
          className="ml-auto text-faint hover:text-ink transition-colors"
          title="Esc"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

/** One verb on the bar — the quiet text button, `destructive` for the verbs
 *  that take things away (hover warms to the alert color). */
export function SelectionVerb({
  icon,
  destructive = false,
  className,
  children,
  ...rest
}: {
  /** The verb's face — a small (13px) lucide glyph beside the label. */
  icon?: React.ReactNode;
  destructive?: boolean;
  className?: string;
  children?: React.ReactNode;
} & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "children"
>): React.JSX.Element {
  return (
    <button
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full ring-1 ring-edge bg-veil/40 px-2.5 py-1 transition-colors text-dim",
        destructive
          ? "hover:text-alert hover:ring-alert/40 hover:bg-alert/10"
          : "hover:text-ink hover:bg-veil hover:ring-edge2",
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
