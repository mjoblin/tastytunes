import { cx } from "@/lib/format";
import type { useDragExtent } from "@/hooks/useDragExtent";

type Props = Pick<ReturnType<typeof useDragExtent>, "dragging" | "snapped" | "handleProps"> & {
  /** The corner it sits in: the one the box grows from. */
  corner: "bottom-right" | "bottom-left";
  label?: string;
  /** A 12px grip for a corner it shares with a chip (Now Playing's art ⋯, 0.12.0-rc.3): small
   *  enough to sit outside the chip's circle when the chip keeps the box's 8px inset. */
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
  const box = compact ? 12 : 28;
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
        viewBox={`0 0 ${box} ${box}`}
        aria-hidden
        className={cx(
          "absolute inset-0 transition-opacity",
          dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          left && "-scale-x-100",
          dragging && snapped ? "text-gold" : "text-dim",
        )}
      >
        <path
          d={compact ? "M10.5 3.5 L3.5 10.5 M10.5 7.5 L7.5 10.5" : "M23 13 L13 23 M23 19 L19 23"}
          stroke="currentColor"
          strokeWidth={compact ? 1.6 : 2}
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </div>
  );
}
