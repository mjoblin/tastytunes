import { useRef, useState } from 'react'
import { DEFAULT_SETTINGS } from '@shared/model'
import { useStore } from '@/store'

/** The persisted default IS the detent — a fresh install opens snapped. */
export const PANEL_DEFAULT_WIDTH = DEFAULT_SETTINGS.panelWidth
const MIN_WIDTH = 250
const MAX_WIDTH = 800
// The default width acts as a magnetic detent while dragging.
const SNAP_RANGE = 12

/**
 * Shared drag-to-resize width for the Now Playing drawers (lyrics/artist).
 * Live during the drag, persisted (settings.panelWidth) on release; the
 * draft is held until the settings round-trip lands so there's no snap-back.
 */
export function usePanelWidth(): {
  width: number
  dragging: boolean
  /** Sitting on the default-width detent. */
  snapped: boolean
  handleProps: {
    onPointerDown(e: React.PointerEvent<HTMLDivElement>): void
    onPointerMove(e: React.PointerEvent<HTMLDivElement>): void
    onPointerUp(e: React.PointerEvent<HTMLDivElement>): void
  }
} {
  const saved = useStore((s) => s.settings.panelWidth)
  const saveSettings = useStore((s) => s.saveSettings)
  const [draft, setDraft] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; w: number } | null>(null)
  const latest = useRef(saved)

  const width = draft ?? saved
  latest.current = width

  const clampSnap = (w: number): number => {
    // Clamp to the viewport-relative cap too, so the logical width never
    // exceeds what the CSS max renders — otherwise the drag has dead travel.
    const max = Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.6))
    const clamped = Math.max(MIN_WIDTH, Math.min(max, w))
    return Math.abs(clamped - PANEL_DEFAULT_WIDTH) <= SNAP_RANGE ? PANEL_DEFAULT_WIDTH : clamped
  }

  return {
    width,
    dragging,
    snapped: width === PANEL_DEFAULT_WIDTH,
    handleProps: {
      onPointerDown: (e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width }
        setDragging(true)
      },
      onPointerMove: (e) => {
        if (!start.current) return
        // right-anchored panel: dragging left grows it
        setDraft(clampSnap(start.current.w + (start.current.x - e.clientX)))
      },
      onPointerUp: () => {
        if (!start.current) return
        start.current = null
        setDragging(false)
        void saveSettings({ panelWidth: latest.current }).then(() => setDraft(null))
      }
    }
  }
}
