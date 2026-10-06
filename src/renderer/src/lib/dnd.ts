import type { Transform } from "@dnd-kit/utilities";

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
