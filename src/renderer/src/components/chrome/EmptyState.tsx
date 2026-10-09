import type { LucideIcon } from "lucide-react";
import { cx } from "@/lib/format";
import { Chip } from "@/components/chrome/Chrome";

/**
 * The screen empty-state idiom: big quiet icon, display-font headline, faint
 * one-liner, optional actions below. One copy — the five screens used to
 * hand-build this with drifting sizes and strokes. Pass className="h-full"
 * when the empty state IS the screen (no header row above it).
 */
export function EmptyState({
  icon: Icon,
  title,
  caption,
  compact,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  caption?: string;
  /**
   * Panel scale. The screen sizes are tuned for a 1200px canvas, and in a
   * 380px window they read as a poster: a 56px glyph, a 24px headline, and
   * 16px of air between the headline and its own caption, which makes the two
   * look unrelated (user, 2026-08-04). Same idiom, panel proportions.
   */
  compact?: boolean;
  className?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-empty-state={title}
      className={cx(
        "flex-1 flex flex-col items-center justify-center text-center",
        compact ? "gap-2.5 px-5" : "gap-4 px-8",
        className,
      )}
    >
      <Icon size={compact ? 34 : 56} strokeWidth={1} className="text-faint/50" />
      {/* Title and caption are ONE block: they are a sentence and its
          footnote, and the gap between them should never be the same as the
          gap to the glyph above. (Non-compact keeps gap-4 between them, so
          the screens render exactly as before.) */}
      <div className={cx("flex flex-col items-center", compact ? "gap-1" : "gap-4")}>
        <div className={cx("font-display text-dim", compact ? "text-[15px]" : "text-2xl")}>
          {title}
        </div>
        {caption && (
          <div
            className={cx(
              "text-faint",
              compact ? "text-[11.5px] leading-snug max-w-[240px]" : "text-[13px] max-w-sm",
            )}
          >
            {caption}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/** One next step from an empty screen: where to go, and the key that goes there. */
export interface EmptyAction {
  label: string;
  icon: LucideIcon;
  /** The screen's single key, shown faint beside the label. */
  keyHint?: string;
  onClick(): void;
}

/**
 * THE WAY ON FROM AN EMPTY SCREEN (0.10.0, the first five minutes): an empty state that has an
 * obvious next step offers it as a row of chips under its caption, rather than only
 * describing where to go. Chips, one gap within a kind, the toolbar's height.
 */
export function EmptyActions({ actions }: { actions: EmptyAction[] }): React.JSX.Element {
  return (
    <div data-empty-actions className="flex flex-wrap items-center justify-center gap-1.5">
      {actions.map((a) => (
        <Chip
          key={a.label}
          data-empty-action={a.label}
          onClick={a.onClick}
          className="gap-1.5 motion-safe:active:scale-95"
        >
          <a.icon size={13} />
          {a.label}
          {a.keyHint && <kbd className="ml-0.5 font-mono text-[10px] text-faint">{a.keyHint}</kbd>}
        </Chip>
      ))}
    </div>
  );
}
