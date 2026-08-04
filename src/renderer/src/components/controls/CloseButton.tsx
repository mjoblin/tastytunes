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
        // `transition`, not `transition-all`: the curated set (color, bg,
        // transform) is all this button animates, and this control mounts
        // inside surfaces that keep a live backdrop blur (lyrics/artist
        // panels), where every animated frame re-runs the blur on software
        // rendering — don't volunteer properties that repaint for free today
        // and expensively tomorrow.
        'p-1.5 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition',
        className
      )}
    >
      <X size={size} />
    </button>
  )
}
