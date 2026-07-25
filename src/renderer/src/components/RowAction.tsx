import { cx } from '@/lib/format'

/**
 * The one hover-action button for a list ROW — play, ⋯, remove.
 *
 * There were four treatments doing this job: the queue used p-1.5/rounded/
 * text-faint, favorites p-1.5/rounded-lg/text-dim with a veil2 hover, playlists
 * copied the queue's, and the library used a full ring-and-panel CHIP inside
 * its rows. A chip is the SCREEN-HEADER idiom (see the header buttons); inside a
 * row it's heavy and reads as a different class of control.
 *
 * Row actions are quiet until you're on the row, then legible: hidden by
 * default, revealed on row hover AND on keyboard focus, so a keyboard user can
 * reach them at all.
 */
export function RowAction({
  icon: Icon,
  label,
  tip,
  onClick,
  destructive,
  /** Keep it visible regardless of hover — e.g. while its own menu is open. */
  pinned,
  size = 14
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  tip?: string
  onClick(e: React.MouseEvent): void
  destructive?: boolean
  pinned?: boolean
  size?: number
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      data-tip={tip ?? label}
      onClick={(e) => {
        e.stopPropagation()
        onClick(e)
      }}
      className={cx(
        'tip-bottom p-1.5 rounded-lg text-dim hover:bg-veil2 transition-all',
        destructive ? 'hover:text-alert' : 'hover:text-ink',
        pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
      )}
    >
      <Icon size={size} />
    </button>
  )
}
