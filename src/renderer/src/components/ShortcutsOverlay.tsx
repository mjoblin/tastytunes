import { CloseButton } from '@/components/CloseButton'
import { useStore } from '@/store'
import { MOD, SCREENS } from '@/lib/screens'

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
      [`${MOD}K`, 'Command palette'],
      [`${MOD}F`, 'Search the library — from anywhere'],
      // letters derive from the shared registry; the prose stays hand-written
      [SCREENS.map((s) => s.key).join(' '), 'Now Playing · Queue · Presets · lIbrary · Tuner · faVorites · Recently Played · Sources · Device · sEttings'],
      ['F', 'Full-screen display mode'],
      ['/', 'Filter the list (Queue · Presets · faVorites · Recently Played)'],
      ['⌘← / ⌘→', 'Back / forward in the Library (Backspace and mouse side buttons too)'],
      ['`', 'SMOIP and Requests console'],
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
        className="w-[540px] max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] flex flex-col rounded-2xl bg-panel ring-1 ring-edge2 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center mb-5 shrink-0">
          <h2 className="font-display font-bold text-lg tracking-tight flex-1">Keyboard shortcuts</h2>
          <CloseButton onClick={() => setShortcutsOpen(false)} />
        </div>
        {/* Scrolls when the window is too short for the full list — the panel
            itself stays inside the viewport (title and close always visible). */}
        <div className="space-y-5 min-h-0 overflow-y-auto -mr-3 pr-3">
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
