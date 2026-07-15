import { cx } from '@/lib/format'

export interface SegmentedOption<T> {
  value: T
  label: string
  icon?: React.ReactNode
}

/**
 * A pill segmented toggle: the active option is filled gold, the rest are
 * translucent (bg-panel/70) so the backdrop shows through — matching the
 * queue/preset follow buttons. Generic over the option value type.
 */
export function Segmented<T extends string | number | boolean>({
  value,
  options,
  onChange,
  className
}: {
  value: T
  options: Array<SegmentedOption<T>>
  onChange(value: T): void
  className?: string
}): React.JSX.Element {
  return (
    <div className={cx('no-drag flex rounded-lg ring-1 ring-edge bg-panel/70 p-0.5', className)}>
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          onClick={() => onChange(opt.value)}
          className={cx(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] transition-colors',
            value === opt.value ? 'bg-golddim text-gold' : 'text-dim hover:text-ink'
          )}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  )
}
