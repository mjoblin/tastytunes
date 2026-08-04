import { X } from 'lucide-react'
import { cx } from '@/lib/format'

/**
 * The one dismiss-a-surface control: a circular close "x" with the app's
 * standard hover fill. Every modal / panel / overlay / mini-player close uses
 * it so they can't drift apart (this replaced a split where panels had the
 * circle-fill and modals had a plain color-only hover).
 *
 * NOT for destructive per-row "remove" x's (e.g. queue rows) — those keep
 * their own alert-colored idiom so a delete never looks like a dismiss.
 *
 * `className` carries positioning/tooltip extras (e.g. `no-drag`, the
 * `tip-*` classes, absolute placement); `tip` sets the tooltip text.
 */
export function CloseButton({
  onClick,
  size = 16,
  label = 'Close',
  tip,
  className
}: {
  onClick: () => void
  size?: number
  label?: string
  tip?: string
  className?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-tip={tip}
      className={cx(
        // NO transition — hover and press SNAP, like the palette's rows. This
        // control mounts inside backdrop-blurred surfaces (every ModalShell,
        // the lyrics/artist panels), where each animated frame re-runs the
        // blur on software rendering: a 150ms transition crawled at
        // ~117ms/frame there, an untransitioned flip pays one ~50ms frame
        // (both measured, 2026-08-04).
        'p-1.5 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90',
        className
      )}
    >
      <X size={size} />
    </button>
  )
}
