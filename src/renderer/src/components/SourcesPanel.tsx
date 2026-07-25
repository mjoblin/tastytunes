import { AudioLines, Bluetooth, Cable, Disc3, Radio, Usb, Wifi } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
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

/**
 * The streamer's inputs, as a Device-screen section (2026-07-25: Sources was
 * its own nav row and is now a tab on Device — both are "system, not music",
 * and switching input is one rarely-used action).
 *
 * A PANEL, not a screen: no header of its own, and no scroller — the Device
 * page owns both, so this renders as a plain list into whatever section hosts
 * it. The rows are unchanged (ringed row idiom, `row-playing` gold on the
 * active input); what went away with the screen is its standalone scroll
 * memory and the scroll-the-active-row-into-view effect, which existed because
 * a full-page list could hide the active row below the fold. Inside a tab the
 * list starts near the top of the page, so there is nothing to reveal.
 */
export function SourcesPanel(): React.JSX.Element {
  const sources = useStore((s) => s.sources)
  const zoneState = useStore((s) => s.zoneState)
  const nowPlaying = useStore((s) => s.nowPlaying)

  const activeId = activeSourceId(zoneState, nowPlaying)
  const selectable = (sources?.sources ?? [])
    .filter((s) => s.ui_selectable)
    .sort((a, b) => a.preferred_order - b.preferred_order)

  return (
    <div className="space-y-1.5">
      {selectable.map((source) => {
        const Icon = iconForClass(source.class)
        const active = source.id === activeId
        return (
          <button
            key={source.id}
            data-source-row={source.id}
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
              <div className={cx('text-[14px]', active ? 'text-gold' : 'text-ink')}>{source.name}</div>
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
  )
}
