import { cx } from "@/lib/format";
import type { useDragExtent } from "@/hooks/useDragExtent";

type Props = Pick<ReturnType<typeof useDragExtent>, "dragging" | "snapped" | "handleProps"> & {
  /** The corner it sits in: the one the box grows from. */
  corner: "bottom-right" | "bottom-left";
  label?: string;
};

/**
 * A box's corner resize grip, the corner counterpart of the drawers' edge handle
 * (PanelResizeHandle): two short diagonal strokes in the corner, seen when the box is
 * hovered or while dragging, gold while sitting on the default detent so the snap is felt
 * AND seen. The box it sits in is a `group`, so the grip shows with the box's other chrome.
 */
export function CornerResizeHandle({
  dragging,
  snapped,
  handleProps,
  corner,
  label = "Resize",
}: Props): React.JSX.Element {
  const left = corner === "bottom-left";
  return (
    <div
      {...handleProps}
      role="separator"
      aria-label={label}
      data-corner-resize={corner}
      className={cx(
        "absolute bottom-0 z-10 h-7 w-7 touch-none",
        left ? "left-0 cursor-nesw-resize" : "right-0 cursor-nwse-resize",
      )}
    >
      <svg
        viewBox="0 0 28 28"
        aria-hidden
        className={cx(
          "absolute inset-0 transition-opacity",
          dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          left && "-scale-x-100",
          dragging && snapped ? "text-gold" : "text-ink/80",
        )}
      >
        <path
          d="M23 13 L13 23 M23 19 L19 23"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </div>
  );
}
