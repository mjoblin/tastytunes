import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '@/lib/format'

interface SliderProps {
  /** 0..1 */
  value: number
  onCommit(value: number): void
  /** Live value while dragging (optional — e.g. show scrub time) */
  onScrub?(value: number): void
  /** Drag aborted (Escape) — nothing was committed. */
  onCancel?(): void
  disabled?: boolean
  ariaLabel: string
  /** 'hover' (default) reveals the thumb on hover/drag; 'always' keeps it visible. */
  thumb?: 'hover' | 'always'
  /**
   * While dragging, float a bubble over the thumb showing this label — the
   * playhead's scrub timestamp, read where the eye already is rather than in
   * the readout off at the end of the bar. Omitted, the slider is unchanged.
   */
  scrubLabel?(value: number): string
}

/** A pointer-driven slider styled as a thin faceplate track with an amber fill. */
export function Slider({
  value,
  onCommit,
  onScrub,
  onCancel,
  disabled,
  ariaLabel,
  thumb = 'hover',
  scrubLabel
}: SliderProps): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragValue, setDragValue] = useState<number | null>(null)
  // Screen coordinates for the scrub bubble, recomputed per pointer move. Kept
  // as state (not derived at render from the ratio) because the bubble is
  // PORTALED to <body> and therefore positioned in viewport space — it needs
  // the track's live rect, which only the pointer handlers have.
  const [bubble, setBubble] = useState<{ left: number; top: number } | null>(null)
  // Hover preview: the same bubble, before any button is pressed — the seek
  // bar is usually CLICKED rather than dragged, and a click needs to know
  // where it will land before it commits. Hover never moves the thumb; only
  // the bubble follows the cursor.
  const [hoverValue, setHoverValue] = useState<number | null>(null)
  const placeBubble = useCallback((ratio: number): void => {
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    // Clamp so a scrub at either extreme doesn't hang off the window. 34px is
    // half a wide timestamp ("1:02:03") plus its padding.
    const x = Math.min(Math.max(rect.left + ratio * rect.width, 34), window.innerWidth - 34)
    setBubble({ left: x, top: rect.top - 10 })
  }, [])

  // Claimed synchronously on pointerdown and released by whichever handler ends
  // the drag FIRST. React's handlers run at the root before a window listener
  // sees the same event, and neither has re-rendered by then — a state flag
  // would be stale and the drag would commit twice.
  const dragRef = useRef(false)

  const ratioFromX = useCallback((clientX: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])
  const ratioFromEvent = useCallback(
    (e: React.PointerEvent): number => ratioFromX(e.clientX),
    [ratioFromX]
  )

  // Escape aborts an in-flight drag without committing.
  const dragging = dragValue !== null
  useEffect(() => {
    if (!dragging) return
    const end = (): void => {
      dragRef.current = false
      setDragValue(null)
      setHoverValue(null)
      setBubble(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        end()
        onCancel?.()
      }
    }
    // Safety net for a release the track never hears — the pointer leaving the
    // window, or capture broken out from under us. Without it the drag stays
    // claimed: the slider freezes at the dragged value (it renders dragValue,
    // not the live one) and any scrub bubble is stranded on screen.
    const onUp = (e: PointerEvent): void => {
      if (!dragRef.current) return
      const v = ratioFromX(e.clientX)
      end()
      onCommit(v)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, onCancel, onCommit, ratioFromX])

  const shown = dragValue ?? Math.max(0, Math.min(1, value))

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      className={cx(
        'group relative h-4 flex items-center no-drag',
        disabled ? 'opacity-35 pointer-events-none' : 'cursor-pointer'
      )}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        dragRef.current = true
        const v = ratioFromEvent(e)
        setDragValue(v)
        placeBubble(v)
        onScrub?.(v)
      }}
      onPointerMove={(e) => {
        const v = ratioFromEvent(e)
        if (dragValue === null) {
          // hover preview — no scrub, no thumb move, label only
          if (scrubLabel) {
            setHoverValue(v)
            placeBubble(v)
          }
          return
        }
        setDragValue(v)
        placeBubble(v)
        onScrub?.(v)
      }}
      onPointerLeave={() => {
        // A drag that wanders off the track keeps its bubble (the pointer is
        // captured and still scrubbing); a hover that leaves loses it.
        setHoverValue(null)
        if (!dragRef.current) setBubble(null)
      }}
      onPointerUp={(e) => {
        if (!dragRef.current) return
        dragRef.current = false
        const v = ratioFromEvent(e)
        setDragValue(null)
        // Release with the pointer still over the track and the bubble simply
        // becomes the hover preview — blinking it out only to bring it back on
        // the next mouse move would read as a glitch.
        const rect = trackRef.current?.getBoundingClientRect()
        const overTrack =
          rect != null &&
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom
        if (scrubLabel && overTrack) {
          setHoverValue(v)
          placeBubble(v)
        } else {
          setHoverValue(null)
          setBubble(null)
        }
        onCommit(v)
      }}
      onPointerCancel={() => {
        if (!dragRef.current) return
        dragRef.current = false
        setDragValue(null)
        setBubble(null)
        onCancel?.()
      }}
    >
      <div className="relative h-[3px] w-full rounded-full bg-veil2 overflow-visible">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gold"
          style={{ width: `${shown * 100}%` }}
        />
        <div
          className={cx(
            'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 rounded-full bg-gold',
            'shadow-[0_0_8px_rgb(var(--gold-rgb)_/_0.7)] transition-opacity',
            dragValue !== null || thumb === 'always'
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100'
          )}
          style={{ left: `${shown * 100}%` }}
        />
      </div>
      {/* Portaled to <body> like the collapsed nav rail's hover bubble: the
          playhead lives inside the playback bar, and a bubble drawn in place
          would be clipped by it. z-50 = the app's menu tier. */}
      {scrubLabel && bubble && (dragValue ?? hoverValue) !== null &&
        createPortal(
          <div
            data-scrub-bubble
            className="fixed z-50 pointer-events-none px-2 py-1 rounded-md bg-raised text-ink text-[11px] font-mono tabular-nums whitespace-nowrap ring-1 ring-edge2 shadow-[0_8px_24px_rgb(0_0_0_/_0.35)]"
            style={{ left: bubble.left, top: bubble.top, transform: 'translate(-50%, -100%)' }}
          >
            {scrubLabel((dragValue ?? hoverValue) as number)}
          </div>,
          document.body
        )}
    </div>
  )
}
