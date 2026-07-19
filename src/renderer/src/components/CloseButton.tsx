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
        'p-1.5 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all',
        className
      )}
    >
      <X size={size} />
    </button>
  )
}
