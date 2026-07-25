import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { usePopoverChrome, useClampedPosition } from '@/hooks/usePopover'

/**
 * The row ⋯ / right-click menu: a truncated title, then plain verbs. One
 * component because three screens (Favorites, Queue, Playlists) had grown
 * byte-identical private copies — the third one's own comment called itself
 * "third instance", which is the cue to extract.
 *
 * Portaled to document.body: rows on these screens are dnd-kit sortables, and
 * a sortable's transform makes it a containing block that would trap a
 * fixed-position menu (see the renderer conventions).
 */
export function RowMenu({
  title,
  at,
  items,
  onClose
}: {
  /** What the menu is about — a track or favorite title, shown truncated. */
  title: string
  at: { x: number; y: number }
  items: Array<{ label: string; run: () => void }>
  onClose(): void
}): React.JSX.Element {
  usePopoverChrome(onClose)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pos = useClampedPosition(boxRef, at.x, at.y)
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={onClose} />
      <div
        ref={boxRef}
        className="fixed z-50 w-52 rounded-xl ring-1 ring-edge2 bg-raised shadow-xl p-1.5 space-y-0.5"
        style={pos}
      >
        <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint truncate">{title}</div>
        {items.map((it) => (
          <button
            key={it.label}
            onClick={() => {
              onClose()
              it.run()
            }}
            className="w-full px-2.5 py-1.5 rounded-lg text-left text-[13px] text-dim hover:text-ink hover:bg-veil transition-colors"
          >
            {it.label}
          </button>
        ))}
      </div>
    </>,
    document.body
  )
}
