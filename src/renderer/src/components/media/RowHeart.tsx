import { Heart } from "lucide-react";
import { cx } from "@/lib/format";

/**
 * The heart on a list ROW, shared by the library and the queue.
 *
 * The behaviour that matters: a SET heart stays visible on the resting row
 * (it's state, not an action), while an unset one is hover-only like the other
 * row actions. Lived in LibraryCards as a private component until the queue
 * needed the same thing — a queued track you're hearing is exactly when you
 * want to keep it.
 */
export function RowHeart({
  favorited,
  held,
  onHeart,
}: {
  favorited: boolean;
  held: boolean;
  onHeart(): void;
}): React.JSX.Element {
  return (
    <button
      aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
      data-row-heart={favorited ? "on" : "off"}
      onClick={(e) => {
        e.stopPropagation();
        onHeart();
      }}
      className={cx(
        "p-1.5 rounded-lg transition-all motion-safe:active:scale-90",
        favorited
          ? "text-gold hover:text-ink"
          : cx(
              "text-dim hover:text-ink hover:bg-veil2",
              held ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            ),
      )}
    >
      <Heart size={13} fill={favorited ? "currentColor" : "none"} />
    </button>
  );
}
