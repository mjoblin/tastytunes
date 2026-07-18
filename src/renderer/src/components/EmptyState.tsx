import type { LucideIcon } from 'lucide-react'
import { cx } from '@/lib/format'

/**
 * The screen empty-state idiom: big quiet icon, display-font headline, faint
 * one-liner, optional actions below. One copy — the five screens used to
 * hand-build this with drifting sizes and strokes. Pass className="h-full"
 * when the empty state IS the screen (no header row above it).
 */
export function EmptyState({
  icon: Icon,
  title,
  caption,
  className,
  children
}: {
  icon: LucideIcon
  title: string
  caption?: string
  className?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'flex-1 flex flex-col items-center justify-center gap-4 text-center px-8',
        className
      )}
    >
      <Icon size={56} strokeWidth={1} className="text-faint/50" />
      <div className="font-display text-2xl text-dim">{title}</div>
      {caption && <div className="text-[13px] text-faint max-w-sm">{caption}</div>}
      {children}
    </div>
  )
}
