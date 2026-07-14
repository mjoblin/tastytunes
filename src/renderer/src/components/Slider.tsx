import { useCallback, useEffect, useRef, useState } from 'react'
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
}

/** A pointer-driven slider styled as a thin faceplate track with an amber fill. */
export function Slider({
  value,
  onCommit,
  onScrub,
  onCancel,
  disabled,
  ariaLabel,
  thumb = 'hover'
}: SliderProps): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragValue, setDragValue] = useState<number | null>(null)

  // Escape aborts an in-flight drag without committing.
  const dragging = dragValue !== null
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setDragValue(null)
        onCancel?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dragging, onCancel])

  const ratioFromEvent = useCallback((e: React.PointerEvent): number => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }, [])

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
        const v = ratioFromEvent(e)
        setDragValue(v)
        onScrub?.(v)
      }}
      onPointerMove={(e) => {
        if (dragValue === null) return
        const v = ratioFromEvent(e)
        setDragValue(v)
        onScrub?.(v)
      }}
      onPointerUp={(e) => {
        if (dragValue === null) return
        const v = ratioFromEvent(e)
        setDragValue(null)
        onCommit(v)
      }}
      onPointerCancel={() => {
        setDragValue(null)
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
    </div>
  )
}
