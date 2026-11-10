import type { CSSProperties } from "react";
import { CSS, type Transform } from "@dnd-kit/utilities";

/**
 * Strip horizontal travel from a sortable's drag transform.
 *
 * A ROW list has exactly one axis, so the pointer's sideways movement is noise:
 * it rides into the transform, widens the scrollable area, and the list drifts
 * sideways under the row being dragged.
 *
 * Applied to the transform rather than as a DndContext `modifiers` entry
 * because — measured, not assumed — modifiers do NOT reach an in-place
 * sortable's transform: they apply to a DragOverlay, which none of these
 * screens use. With modifiers set, the active row still tracked the pointer to
 * x=222 while its displaced siblings sat at x=0 (their offset comes from the
 * sorting strategy, not the drag). Locking here is what actually holds.
 *
 * CARD grids must NOT use this — rectSortingStrategy is two-dimensional, and
 * sideways movement is how you reach the next column.
 */
export const lockVertical = (t: Transform | null): Transform | null => (t ? { ...t, x: 0 } : null);

/**
 * Where dnd-kit puts its screen-reader text: the page's body, never inside the list.
 *
 * Without a container DndContext renders two hidden elements (the instructions and the
 * live region) as the list's LAST children, one render after it mounts. A list whose
 * dividers are `divide-y` (or whose rhythm is `space-y`) styles every child but the last,
 * so the last row turned into a middle one a frame after arriving: it gained a bottom
 * border whose colour faded in from the default (the white text colour) through the row's
 * transition-colors, a white line flashing under the last playlist track on every visit
 * (user, 2026-10-06), and a hairline under it once settled. Every DndContext passes this.
 */
export const DND_ACCESSIBILITY = { container: document.body };

/** A row's own transition, Tailwind's `transition-colors`: its hover fill. */
export const ROW_MOTION = [
  "color",
  "background-color",
  "border-color",
  "outline-color",
  "text-decoration-color",
  "fill",
  "stroke",
]
  .map((p) => `${p} 150ms cubic-bezier(0.4, 0, 0.2, 1)`)
  .join(", ");

/**
 * A sortable item's inline style: dnd-kit's transform, and its transition after the item's own.
 *
 * dnd-kit's transition is about `transform` alone, but set inline it replaced the item's whole
 * CSS transition. And it stays: a render that hands SortableContext a new array of ids (each of
 * these lists maps its items afresh) stamps `transform 0ms linear` on every item, meant for the
 * frame after a drop, and no later render takes it off. The Queue's and Presets' cards then
 * snapped to their hover size where the Library's grow (his look, 2026-10-30), and the rows'
 * hover fill snapped too. So the item's own transition (`own`, in place of a transition class)
 * leads and dnd-kit's follows: a property named twice takes its last entry, so `transform`
 * keeps dnd-kit's timing and everything else keeps the item's. A list that can't be dragged
 * passes no transform and no transition, and keeps its own.
 */
export function sortableStyle(
  transform: Transform | null,
  transition: string | undefined,
  own?: string,
): CSSProperties {
  return {
    transform: CSS.Transform.toString(transform),
    transition: [own, transition].filter(Boolean).join(", ") || undefined,
  };
}
