import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '@/lib/format'
import { PopoverChrome, usePopoverChrome, useClampedPosition } from '@/hooks/usePopover'

/**
 * The two overlay shells. Every transient surface in the app is one of these:
 * a POPOVER anchored at a click, or a MODAL centred over a dimmed room.
 *
 * They existed as ~10 hand-rolled copies of the same four lines (portal,
 * backdrop, clamp, card classes) — the copies had already started to drift,
 * which is what a shell prevents.
 */

/**
 * The popover card surface. Exported on its own for the ANCHORED dropdowns
 * (SortChip, the lens rails' "+N more" and picker pills) which position
 * themselves against their trigger with `absolute top-full` and so have no use
 * for the portal or the click-point clamp — they take the surface and nothing
 * else, deliberately.
 *
 * NB the playback-bar dropdowns (sleep timer, device switcher, signal lamp) and
 * the preset-volume popover wear `shadow-2xl` rather than `shadow-xl`. That is
 * either drift or a deliberate lift over the bar; either way changing it is a
 * visible change, so they are left alone here.
 */
export const POPOVER_CARD = 'rounded-xl ring-1 ring-edge2 bg-raised shadow-xl'

/**
 * A popover anchored at a click point: portaled to <body>, backed by a
 * full-window click-catcher, clamped on-screen by its measured size, and
 * mounting the popover chrome (Escape-capture + inert drag regions).
 *
 * PORTALED ON PURPOSE — rows on several of these screens are dnd-kit
 * sortables, and a sortable's transform makes it a containing block that would
 * trap a fixed-position card (see the renderer conventions).
 *
 * `width` is a Tailwind width class and `className` carries the padding and
 * spacing; the card surface itself is never a caller's business.
 */
export function PopoverCard({
  at,
  width,
  onClose,
  rightClickCloses = false,
  className,
  children,
  ...rest
}: {
  /** Where the click happened — the card is clamped to stay fully on-screen. */
  at: { x: number; y: number }
  /** Tailwind width class: w-52, w-[272px]. */
  width: string
  onClose(): void
  /** Menus opened by right-click also dismiss on right-click elsewhere. */
  rightClickCloses?: boolean
  /** Padding/spacing for the card's contents. */
  className?: string
  children: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children' | 'style'>): React.JSX.Element {
  usePopoverChrome(onClose)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pos = useClampedPosition(boxRef, at.x, at.y)

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={rightClickCloses ? onClose : undefined}
      />
      <div
        ref={boxRef}
        className={cx('fixed z-50', width, POPOVER_CARD, className)}
        style={pos}
        {...rest}
      >
        {children}
      </div>
    </>,
    document.body
  )
}

/**
 * A centred modal over the dimmed, blurred room: backdrop click closes, the
 * panel swallows its own clicks.
 *
 * `escapeCloses` mounts the popover chrome for modals that own their own open
 * state (the save-queue dialog). The two store-backed overlays — shortcuts and
 * info — are closed by the app's global Escape cascade instead, and mounting a
 * second handler here would just fight it.
 */
export function ModalShell({
  onClose,
  escapeCloses = false,
  className,
  children
}: {
  onClose(): void
  escapeCloses?: boolean
  /** Panel geometry — width, max-*, flex, padding. The surface is the shell's. */
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    // Dim only, NO live backdrop blur (2026-08-04, same ruling as the ambient
    // wash bake): a backdrop-filter re-blurs the room on every repaint of its
    // subtree, so hover transitions inside the modal ran at ~117ms/frame p95
    // on the software path (GPU-less VMs, RDP) and 8.7ms without the blur —
    // measured A/B, real hover cycles. /70 keeps the room receding.
    <div
      className="absolute inset-0 z-30 bg-black/70 flex items-center justify-center"
      onClick={onClose}
    >
      {escapeCloses && <PopoverChrome onClose={onClose} />}
      <div
        className={cx('rounded-2xl bg-panel ring-1 ring-edge2 shadow-2xl', className)}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
