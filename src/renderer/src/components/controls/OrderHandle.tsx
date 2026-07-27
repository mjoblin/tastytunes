import type { DraggableAttributes } from '@dnd-kit/core'
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities'
import { GripVertical } from 'lucide-react'

/**
 * The leading cell of a reorderable row: its POSITION at rest, its drag handle
 * on hover.
 *
 * The grip used to sit among the trailing hover actions, which read oddly —
 * play/⋯/remove all *do something to the track*, while dragging is about where
 * the track SITS. That's the same thing the position number says, so the two
 * share one cell: the number fades out, the grip fades in. Costs no layout (the
 * 26px column already existed on every reorderable row) and needs no new
 * column, which is what made the alternatives unattractive.
 *
 * Used by the queue, playlists and presets — every list that reorders.
 */
export function OrderHandle({
  label,
  attributes,
  listeners,
  children
}: {
  /** Accessible name for the handle, e.g. `Reorder ${title}`. */
  label: string
  /** Straight from useSortable. */
  attributes?: DraggableAttributes
  listeners?: SyntheticListenerMap
  /** What shows at rest — a track number, slot number, or the playing eqbars. */
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="relative flex items-center justify-center">
      <span className="flex items-center justify-center transition-opacity group-hover:opacity-0">
        {children}
      </span>
      <button
        aria-label={label}
        title="Drag to reorder"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-0 grid place-items-center rounded text-dim opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-ink cursor-grab active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </button>
    </div>
  )
}
