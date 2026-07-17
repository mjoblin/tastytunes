import { Search, X } from 'lucide-react'
import { cx } from '@/lib/format'

/**
 * Compact text filter for the list screens' headers. `/` focuses it from
 * anywhere (useShortcuts); Escape clears, then blurs. Shows shown/total while
 * active; the value lives in the store per screen (session only), so an
 * active filter is always visible in the box.
 */
export function FilterInput({
  value,
  onChange,
  shown,
  total
}: {
  value: string
  onChange(value: string): void
  shown: number
  total: number
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'no-drag flex items-center gap-1.5 h-8 pl-2.5 pr-1.5 rounded-lg ring-1 transition-all',
        value ? 'ring-gold/50 bg-golddim' : 'ring-edge bg-panel/70 focus-within:ring-edge2'
      )}
    >
      <Search size={13} className={value ? 'text-gold' : 'text-faint'} />
      <input
        data-filter-input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            if (value) onChange('')
            else (e.target as HTMLInputElement).blur()
          }
        }}
        placeholder="Filter"
        spellCheck={false}
        className="w-28 bg-transparent outline-none text-[12.5px] text-ink placeholder:text-faint"
      />
      {value && (
        <>
          {/* min-width fits the widest possible count ("30/30") so the box
              doesn't resize as the shown count's digits change while typing */}
          <span
            className="font-mono text-[10.5px] text-dim tabular-nums text-right"
            style={{ minWidth: `${String(total).length * 2 + 1}ch` }}
          >
            {shown}/{total}
          </span>
          <button
            aria-label="Clear filter"
            onClick={() => onChange('')}
            className="p-1 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
          >
            <X size={12} />
          </button>
        </>
      )}
    </div>
  )
}
