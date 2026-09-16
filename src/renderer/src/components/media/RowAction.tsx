import { useState } from "react";
import { cx } from "@/lib/format";

/**
 * The one hover-action button for a list ROW — play, ⋯, remove.
 *
 * There were four treatments doing this job: the queue used p-1.5/rounded/
 * text-faint, favorites p-1.5/rounded-lg/text-dim with a veil2 hover, playlists
 * copied the queue's, and the library used a full ring-and-panel CHIP inside
 * its rows. A chip is the SCREEN-HEADER idiom (see the header buttons); inside a
 * row it's heavy and reads as a different class of control.
 *
 * Row actions are quiet until you're on the row, then legible: hidden by
 * default, revealed on row hover AND on keyboard focus, so a keyboard user can
 * reach them at all.
 *
 * A CLICKED ACTION STOPS EXPLAINING ITSELF until the pointer moves. The tip is
 * CSS hover with a 0.45s delay, and a click that opens a menu leaves the
 * pointer parked on the button: the menu's backdrop takes the hover, the menu
 * closes, the hover resumes, and "More actions" appears for an interaction
 * that is over (user, 2026-09-11: "oddly showing when I don't expect it to").
 * Quiet is cleared by real movement, measured from the click, not by a
 * pointer-leave, which a backdrop coming and going also fires.
 */
export function RowAction({
  icon: Icon,
  label,
  tip,
  onClick,
  destructive,
  /** Keep it visible regardless of hover — e.g. while its own menu is open. */
  pinned,
  /** This action's own menu or popover is open: shown, and LIT, as a picker
   *  pill or a header chip is while theirs is open — the pressed look belongs
   *  to the control that owns the menu, not to whichever button the pointer
   *  happened to be over (user, 2026-09-12). */
  open,
  size = 14,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  tip?: string;
  onClick(e: React.MouseEvent): void;
  destructive?: boolean;
  pinned?: boolean;
  open?: boolean;
  size?: number;
}): React.JSX.Element {
  const [quietFrom, setQuietFrom] = useState<{ x: number; y: number } | null>(null);
  return (
    <button
      aria-label={label}
      data-tip={quietFrom ? undefined : (tip ?? label)}
      onClick={(e) => {
        e.stopPropagation();
        setQuietFrom({ x: e.clientX, y: e.clientY });
        onClick(e);
      }}
      onPointerMove={(e) => {
        if (quietFrom && Math.hypot(e.clientX - quietFrom.x, e.clientY - quietFrom.y) > 4)
          setQuietFrom(null);
      }}
      className={cx(
        "tip-bottom p-1.5 rounded-lg text-dim hover:bg-veil2 transition-all",
        destructive ? "hover:text-alert" : "hover:text-ink",
        open && "bg-veil2 text-ink",
        // shown on hover, while pinned, or while the row holds its menu (MediaRow's held)
        pinned || open
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100 group-data-[held]:opacity-100 focus-visible:opacity-100",
      )}
    >
      <Icon size={size} />
    </button>
  );
}
