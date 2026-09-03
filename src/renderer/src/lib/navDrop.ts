import type { Screen } from "@/store";
import { flashTarget } from "@/lib/scroll";

/**
 * Drag-to-rail geometry: which nav target sits under the pointer. Pure
 * rect hit-testing against the rail's rows — no droppable machinery, so
 * every drag engine (the queue's dnd-kit drags, the Library's pointer
 * ghost) shares one answer. A hidden nav row simply has no element and
 * can't be hit.
 */
export function navDropTargetAt(x: number, y: number, allowed: Screen[]): Screen | null {
  for (const id of allowed) {
    const el = document.querySelector(`[data-nav-screen="${id}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
  }
  return null;
}

/** The gold acknowledgment on a rail row that just received a drop — the
 *  arrival wash, reused (one signal for "here is the row you asked for"). */
export function flashNavTarget(id: Screen): void {
  flashTarget(document.querySelector<HTMLElement>(`[data-nav-screen="${id}"]`));
}

/** The chip's footprint for clamping (320px card + stack overhang). */
const CHIP_W = 324;
const CHIP_H = 72;
const EDGE = 4;

/**
 * Keep the drag chip fully inside the window: a cursor past the window's
 * edge would clip the chip mid-card, so it presses against the boundary and
 * slides along it instead — the in-window reading of a native drag ghost
 * following the cursor out.
 */
export function clampChipPos(x: number, y: number): { left: number; top: number } {
  return {
    left: Math.min(Math.max(x + 14, EDGE), window.innerWidth - CHIP_W),
    top: Math.min(Math.max(y + 10, EDGE), window.innerHeight - CHIP_H),
  };
}
