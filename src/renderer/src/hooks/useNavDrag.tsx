import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { DragChip } from "@/components/controls/DragChip";
import { clampChipPos, navDropTargetAt } from "@/lib/navDrop";
import { useStore, type Screen } from "@/store";

interface DragInfo {
  count: number;
  title: string;
  artUrl?: string | null;
  noun?: string;
  artKind?: "track" | "album";
}

/**
 * The Library-side drag engine: a pointer-based drag whose only destination
 * is the nav rail. Tracks don't reorder in the Library, so dnd-kit here
 * would be machinery without a job — this is a press on a selected row, a
 * ~6px travel to arm (bare clicks stay clicks), the shared chip riding the
 * cursor, rail targets glowing through the store's navDropTarget, Esc
 * cancelling, and the release routing the drop. One click is swallowed
 * after an armed drag so the release never plays a track.
 */
export function useNavDrag({
  targets,
  payload,
  onDrop,
}: {
  targets: Screen[];
  /** The dragged content, read at press time; null means nothing to drag. */
  payload(): DragInfo | null;
  onDrop(target: Screen, at: { x: number; y: number }): void;
}): { start(e: React.PointerEvent): void; ghost: React.ReactNode } {
  const [drag, setDrag] = useState<(DragInfo & { x: number; y: number }) | null>(null);
  const session = useRef<{ sx: number; sy: number; armed: boolean; info: DragInfo } | null>(null);

  const start = (e: React.PointerEvent): void => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const info = payload();
    if (!info) return;
    session.current = { sx: e.clientX, sy: e.clientY, armed: false, info };

    const swallowClick = (ce: MouseEvent): void => {
      ce.stopPropagation();
      ce.preventDefault();
    };
    const move = (ev: PointerEvent): void => {
      const s = session.current;
      if (!s) return;
      if (!s.armed) {
        // the activation distance keeps clicks meaning play
        if (Math.hypot(ev.clientX - s.sx, ev.clientY - s.sy) < 6) return;
        s.armed = true;
        useStore.getState().setNavDragActive(true);
      }
      ev.preventDefault();
      useStore.getState().setNavDropTarget(navDropTargetAt(ev.clientX, ev.clientY, targets));
      setDrag({ ...s.info, x: ev.clientX, y: ev.clientY });
    };
    const finish = (ev: PointerEvent | null, drop: boolean): void => {
      const s = session.current;
      session.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", onKey, true);
      const nav = useStore.getState().navDropTarget;
      useStore.getState().setNavDropTarget(null);
      useStore.getState().setNavDragActive(false);
      setDrag(null);
      if (s?.armed) {
        if (ev != null) {
          // Finished by the release itself: its click follows immediately.
          window.addEventListener("click", swallowClick, { capture: true, once: true });
          setTimeout(() => window.removeEventListener("click", swallowClick, true), 150);
        } else {
          // Cancelled by Esc with the button still held: the abort's release
          // is the NEXT pointerup, whenever it comes — swallow its click,
          // and only its click (a plain timeout missed late releases and the
          // click deselected; user, 2026-08-30).
          const onAbortRelease = (): void => {
            window.addEventListener("click", swallowClick, { capture: true, once: true });
            setTimeout(() => window.removeEventListener("click", swallowClick, true), 150);
          };
          window.addEventListener("pointerup", onAbortRelease, { capture: true, once: true });
        }
        if (drop && nav != null && ev != null) onDrop(nav, { x: ev.clientX, y: ev.clientY });
      }
    };
    const up = (ev: PointerEvent): void => finish(ev, true);
    const onKey = (ev: KeyboardEvent): void => {
      // Esc mid-drag cancels the DRAG only — the selection Esc must not fire
      if (ev.key === "Escape" && session.current?.armed) {
        // stopIMMEDIATE: the selection surfaces' Esc handlers listen on the
        // same window node, and plain stopPropagation would still run them —
        // cancelling a drag must not also clear the selection.
        ev.stopImmediatePropagation();
        ev.preventDefault();
        finish(null, false);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", onKey, true);
  };

  const ghost =
    drag != null
      ? createPortal(
          <div
            data-nav-drag-ghost
            className="pointer-events-none fixed z-50"
            style={clampChipPos(drag.x, drag.y)}
          >
            <DragChip
              title={drag.title}
              artUrl={drag.artUrl}
              count={drag.count}
              noun={drag.noun}
              artKind={drag.artKind}
            />
          </div>,
          document.body,
        )
      : null;

  return { start, ghost };
}
