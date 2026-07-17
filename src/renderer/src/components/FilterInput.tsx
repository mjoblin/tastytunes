import { useEffect, useRef } from 'react'
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
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Clicks on non-focusable chrome don't move focus off an input, so the
  // caret would keep blinking — blur explicitly when a press lands outside.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (
        document.activeElement === inputRef.current &&
        !wrapRef.current?.contains(e.target as Node)
      ) {
        inputRef.current?.blur()
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [])

  return (
    <div
      ref={wrapRef}
      className={cx(
        'no-drag flex items-center gap-1.5 h-8 pl-2.5 pr-1.5 rounded-lg ring-1 transition-all',
        value ? 'ring-gold/50 bg-golddim' : 'ring-edge bg-panel/70 focus-within:ring-edge2'
      )}
    >
      <Search size={13} className={value ? 'text-gold' : 'text-faint'} />
      <input
        ref={inputRef}
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
      {/* count + clear always occupy their space (9ch floor fits "1234/1234";
          only an absurd count grows it) so the box width never changes — they
          just turn invisible while the filter is empty */}
      <span className="font-mono text-[10.5px] text-dim tabular-nums text-right min-w-[9ch]">
        {value ? `${shown}/${total}` : ''}
      </span>
      <button
        aria-label="Clear filter"
        onClick={() => onChange('')}
        className={cx(
          'p-1 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all',
          !value && 'invisible pointer-events-none'
        )}
      >
        <X size={12} />
      </button>
    </div>
  )
}
