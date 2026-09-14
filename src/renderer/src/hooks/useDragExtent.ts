import { useRef, useState } from "react";
import { useStore } from "@/store";

// The default extent acts as a magnetic detent while dragging.
const SNAP_RANGE = 12;

/**
 * Drag-to-resize ONE extent of a surface: the Now Playing drawers' width
 * (usePanelWidth), the diagnostics drawer's height. Live during the drag,
 * persisted on release; the draft is held until the settings round-trip lands
 * so there is no snap-back. Written once here (2026-09-12) when the drawer
 * needed the width hook's exact behaviour for its height — a second hook
 * would have been the same forty lines with x for y. A release that changed
 * the extent puts one entry on the undo stack (2026-09-13, the user's ask
 * after the art grip): Cmd-Z saves the size the drag started from, one home
 * for the art, the panels and the drawer alike; no entry for a release that
 * landed where it began.
 */
export function useDragExtent({
  saved,
  save,
  detent,
  min,
  max,
  axis,
  grow,
  undoLabel,
}: {
  /** The persisted value. */
  saved: number;
  save(next: number): Promise<void>;
  /** The default, and the detent the drag snaps to. */
  detent: number;
  min: number;
  /** Read at drag time, so a viewport-relative cap follows the window: the
   *  logical extent never exceeds what the CSS max renders, or the drag has
   *  dead travel. */
  max(): number;
  /** The pointer axis that moves it, and the sign: a right-anchored panel grows
   *  as the pointer moves LEFT (x, -1); a bottom-anchored drawer as it moves UP
   *  (y, -1). */
  axis: "x" | "y";
  grow: 1 | -1;
  /** The undo entry's label ("Resize Album Art"); none means no undo entry. */
  undoLabel?: string;
}): {
  size: number;
  dragging: boolean;
  /** Sitting on the detent. */
  snapped: boolean;
  handleProps: {
    onPointerDown(e: React.PointerEvent<HTMLDivElement>): void;
    onPointerMove(e: React.PointerEvent<HTMLDivElement>): void;
    onPointerUp(e: React.PointerEvent<HTMLDivElement>): void;
  };
} {
  const [draft, setDraft] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ at: number; size: number } | null>(null);
  const latest = useRef(saved);

  const size = draft ?? saved;
  latest.current = size;

  const clampSnap = (v: number): number => {
    const clamped = Math.max(min, Math.min(max(), v));
    return Math.abs(clamped - detent) <= SNAP_RANGE ? detent : clamped;
  };
  const at = (e: React.PointerEvent): number => (axis === "x" ? e.clientX : e.clientY);

  return {
    size,
    dragging,
    snapped: size === detent,
    handleProps: {
      onPointerDown: (e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { at: at(e), size };
        setDragging(true);
      },
      onPointerMove: (e) => {
        if (!start.current) return;
        setDraft(clampSnap(start.current.size + grow * (at(e) - start.current.at)));
      },
      onPointerUp: () => {
        if (!start.current) return;
        const from = start.current.size;
        start.current = null;
        setDragging(false);
        void save(latest.current).then(() => setDraft(null));
        if (undoLabel && latest.current !== from)
          useStore.getState().pushUndo(undoLabel, () => save(from));
      },
    },
  };
}
