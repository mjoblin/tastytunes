import { X } from 'lucide-react'
import { useStore } from '@/store'

const MOD = /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'

const GROUPS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: 'Playback',
    rows: [
      ['Space / K', 'Play / pause'],
      ['← / →', 'Previous / next track'],
      ['J / L', 'Seek −10s / +10s'],
      ['1 – 9', 'Recall preset']
    ]
  },
  {
    title: 'Volume',
    rows: [
      ['↑ / ↓', 'Volume up / down'],
      ['Shift + ↑ / ↓', 'Volume ±5'],
      ['Scroll', 'Over the volume control: up / down'],
      ['M', 'Mute']
    ]
  },
  {
    title: 'Navigate',
    rows: [
      [`${MOD} K`, 'Command palette'],
      ['N Q P L R S D E', 'Now Playing · Queue · Presets · Library · Recently · Sources · Device · sEttings'],
      ['F', 'Full-screen display mode'],
      ['/', 'Filter the list (Queue · Presets · Recently)'],
      ['`', 'SMOIP payload console'],
      ['?', 'This overlay']
    ]
  }
]

export function ShortcutsOverlay(): React.JSX.Element {
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen)

  return (
    <div
      className="absolute inset-0 z-30 bg-black/60 backdrop-blur-sm flex items-center justify-center"
      onClick={() => setShortcutsOpen(false)}
    >
      <div
        className="w-[440px] rounded-2xl bg-panel ring-1 ring-edge2 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center mb-5">
          <h2 className="font-display font-bold text-lg tracking-tight flex-1">Keyboard shortcuts</h2>
          <button onClick={() => setShortcutsOpen(false)} className="p-1 text-faint hover:text-dim">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-5">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <div className="microlabel mb-2">{group.title}</div>
              <div className="space-y-1.5">
                {group.rows.map(([keys, action]) => (
                  <div key={keys} className="flex items-baseline gap-4">
                    <span className="font-mono text-[11px] text-amber w-28 shrink-0">{keys}</span>
                    <span className="text-[12.5px] text-dim">{action}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
