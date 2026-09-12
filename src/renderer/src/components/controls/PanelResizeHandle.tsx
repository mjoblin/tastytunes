import { cx } from "@/lib/format";
import type { useDragExtent } from "@/hooks/useDragExtent";

type Props = Pick<ReturnType<typeof useDragExtent>, "dragging" | "snapped" | "handleProps"> & {
  /** Which edge it sits on: `vertical` is the drawers' LEFT edge (the width
   *  grip), `horizontal` the diagnostics drawer's TOP edge (its height). */
  orientation?: "vertical" | "horizontal";
  label?: string;
};

/**
 * The drawers' edge resize grip: invisible until hovered (or dragging), gold
 * while sitting on the default detent so the snap is felt AND seen.
 */
export function PanelResizeHandle({
  dragging,
  snapped,
  handleProps,
  orientation = "vertical",
  label = "Resize panel",
}: Props): React.JSX.Element {
  const vertical = orientation === "vertical";
  return (
    <div
      {...handleProps}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      className={cx(
        "group absolute touch-none z-10",
        vertical
          ? "inset-y-0 left-0 w-2 cursor-col-resize"
          : "inset-x-0 top-0 h-2 cursor-row-resize",
      )}
    >
      <div
        className={cx(
          "absolute rounded-full transition-opacity",
          vertical ? "inset-y-0 left-[2px] w-[3px]" : "inset-x-0 top-[2px] h-[3px]",
          dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          dragging && snapped ? "bg-gold/70" : "bg-edge2",
        )}
      />
    </div>
  );
}
