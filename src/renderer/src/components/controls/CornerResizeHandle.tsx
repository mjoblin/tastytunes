import { cx } from "@/lib/format";
import type { useDragExtent } from "@/hooks/useDragExtent";

type Props = Pick<ReturnType<typeof useDragExtent>, "dragging" | "snapped" | "handleProps"> & {
  /** The corner it sits in: the one the box grows from. */
  corner: "bottom-right" | "bottom-left";
  label?: string;
  /** A 12px grip for a corner it shares with a chip (Now Playing's art ⋯, 0.12.0-rc.3): its
   *  hit area small enough to sit outside the chip's circle when the chip keeps the box's 8px
   *  inset. Only the hit area shrinks: the strokes keep their size and place, drawn past it and
   *  deaf to the pointer (drawn inside 12px they slid onto the box's rounded corner and faded). */
  compact?: boolean;
};

/**
 * A box's corner resize grip, the corner counterpart of the drawers' edge handle
 * (PanelResizeHandle): two short diagonal strokes in the corner, seen when the box is
 * hovered or while dragging, in the app's normal text tone (the nav rail's text-dim; the
 * brighter ink read as glare over the art, user 2026-09-13), gold while sitting on the
 * default detent so the snap is felt AND seen. The box it sits in is a `group`, so the grip
 * shows with the box's other chrome.
 */
export function CornerResizeHandle({
  dragging,
  snapped,
  handleProps,
  corner,
  label = "Resize",
  compact = false,
}: Props): React.JSX.Element {
  const left = corner === "bottom-left";
  return (
    <div
      {...handleProps}
      role="separator"
      aria-label={label}
      data-corner-resize={corner}
      className={cx(
        "absolute bottom-0 z-10 touch-none",
        compact ? "h-3 w-3" : "h-7 w-7",
        left ? "left-0 cursor-nesw-resize" : "right-0 cursor-nwse-resize",
      )}
    >
      <svg
        viewBox="0 0 28 28"
        aria-hidden
        className={cx(
          "pointer-events-none absolute bottom-0 h-7 w-7 transition-opacity",
          left ? "left-0" : "right-0",
          dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-kbd:opacity-100",
          left && "-scale-x-100",
          dragging && snapped ? "text-gold" : "text-dim",
        )}
      >
        <path
          // a pixel nearer the corner than before, so beside the ⋯ they clear its circle by 4px
          d="M24 14 L14 24 M24 20 L20 24"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </div>
  );
}
