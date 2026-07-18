import { useCallback, useEffect, useRef } from 'react'
import { AudioLines, Bluetooth, Cable, Disc3, Radio, Usb, Wifi } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { activeSourceId, cx } from '@/lib/format'

function iconForClass(klass: string): typeof AudioLines {
  if (/bluetooth/i.test(klass)) return Bluetooth
  if (/radio/i.test(klass)) return Radio
  if (/usb/i.test(klass)) return Usb
  if (/media|stream/i.test(klass)) return Wifi
  if (/cd|disc/i.test(klass)) return Disc3
  if (/digital|analog|spdif|toslink/i.test(klass)) return Cable
  return AudioLines
}

export function SourcesScreen(): React.JSX.Element {
  const sources = useStore((s) => s.sources)
  const zoneState = useStore((s) => s.zoneState)
  const nowPlaying = useStore((s) => s.nowPlaying)

  const activeId = activeSourceId(zoneState, nowPlaying)
  const selectable = (sources?.sources ?? [])
    .filter((s) => s.ui_selectable)
    .sort((a, b) => a.preferred_order - b.preferred_order)

  // After scroll-memory restore, make sure the active source is on screen —
  // aligned to the bottom of the visible area when it needs scrolling to.
  const scrollMemory = useScrollMemory('sources')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node
      scrollMemory(node)
    },
    [scrollMemory]
  )
  useEffect(() => {
    const container = containerRef.current
    const el = container?.querySelector('[data-active="true"]')
    if (!container || !el) return
    const cRect = container.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const visible = eRect.top >= cRect.top && eRect.bottom <= cRect.bottom
    if (!visible) {
      // Align to the bottom with a small margin so the row's ring isn't clipped.
      container.scrollTo({ top: container.scrollTop + (eRect.bottom - cRect.bottom) + 8 })
    }
  }, [activeId])

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <h1 className="font-display font-bold text-[26px] tracking-tight">Sources</h1>
      </header>

      {/* pt-1 so the active row's ring isn't clipped at the top of the scroll area */}
      <div ref={setContainerRef} className="flex-1 overflow-y-auto px-8 pb-8 pt-1">
        <div className="max-w-xl space-y-1.5">
          {selectable.map((source) => {
            const Icon = iconForClass(source.class)
            const active = source.id === activeId
            return (
              <button
                key={source.id}
                data-active={active || undefined}
                onClick={() => void tt.command({ type: 'setSource', sourceId: source.id })}
                className={cx(
                  'w-full flex items-center gap-4 rounded-xl px-4 py-3 ring-1 transition-all text-left',
                  active
                    ? 'row-playing bg-gold/10' // gold ring + subtler bloom (list variant)
                    : 'ring-edge bg-panel/70 hover:bg-raised/70 hover:ring-edge2'
                )}
              >
                <Icon size={18} strokeWidth={1.6} className={active ? 'text-gold' : 'text-dim'} />
                <div className="flex-1 min-w-0">
                  <div className={cx('text-[14px]', active ? 'text-gold' : 'text-ink')}>
                    {source.name}
                  </div>
                  <div className="microlabel mt-0.5">{source.id}</div>
                </div>
                {active && <span className="led led-on" />}
              </button>
            )
          })}
          {selectable.length === 0 && (
            <div className="text-[13px] text-faint">No selectable sources reported.</div>
          )}
        </div>
      </div>
    </div>
  )
}
