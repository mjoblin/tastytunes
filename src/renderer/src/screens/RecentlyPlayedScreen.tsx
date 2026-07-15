import { useEffect, useState } from 'react'
import { Disc3, History, Radio, Trash2 } from 'lucide-react'
import type { RecentTrack } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { fmtDayBucket, fmtRelative } from '@/lib/format'

/** Read-only local history of tracks the streamer has played. */
export function RecentlyPlayedScreen(): React.JSX.Element {
  const recents = useStore((s) => s.recents)

  // Must be called unconditionally (Rules of Hooks): clearing history flips the
  // list between empty and non-empty, and a hook nested in that branch would
  // change the render's hook count and crash the whole tree.
  const scrollRef = useScrollMemory('recently-played')

  // Keep the "x min ago" labels and day buckets fresh without a reload.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (recents.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [recents.length])

  // Group the (already newest-first) log into day sections.
  const groups: Array<{ label: string; items: Array<{ entry: RecentTrack; index: number }> }> = []
  recents.forEach((entry, index) => {
    const label = fmtDayBucket(entry.at, now)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push({ entry, index })
    else groups.push({ label, items: [{ entry, index }] })
  })

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <h1 className="font-display font-bold text-[26px] tracking-tight">Recently Played</h1>
        <div className="flex-1" />
        {recents.length > 0 && (
          <button
            onClick={() => void tt.clearRecents()}
            className="no-drag flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-edge text-[12.5px] text-dim
                       hover:text-alert hover:ring-edge2 transition-all"
          >
            <Trash2 size={14} strokeWidth={1.8} />
            Clear history
          </button>
        )}
      </header>

      {recents.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8">
          <History size={48} strokeWidth={1.2} className="text-faint/60" />
          <div className="font-display text-xl text-dim">No history yet</div>
          <div className="text-[13px] text-faint max-w-sm">
            Tracks and stations you play will collect here — a local log, kept only on this
            computer.
          </div>
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 pb-8 pt-1">
          <div className="max-w-2xl space-y-6">
            {groups.map((group) => (
              <div key={group.label}>
                <div className="microlabel mb-2 px-1">{group.label}</div>
                <div className="space-y-1">
                  {group.items.map(({ entry, index }) => (
                    <RecentRow key={`${entry.at}-${index}`} entry={entry} now={now} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="microlabel mt-6 px-1">
            up to 200 entries · stored locally · clears on demand
          </div>
        </div>
      )}
    </div>
  )
}

function RecentRow({ entry, now }: { entry: RecentTrack; now: number }): React.JSX.Element {
  const title = entry.isRadio ? (entry.station ?? entry.title) : entry.title
  const subtitle = entry.isRadio
    ? entry.title
    : [entry.artist, entry.album].filter(Boolean).join(' — ')
  const FallbackIcon = entry.isRadio ? Radio : Disc3

  return (
    <div className="flex items-center gap-4 rounded-xl px-3 py-2.5 ring-1 ring-edge bg-panel/60">
      <div className="h-11 w-11 shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        {entry.artUrl ? (
          <img src={entry.artUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <FallbackIcon size={17} className="text-faint" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-ink truncate">{title ?? '—'}</div>
        {subtitle && <div className="text-[12px] text-dim truncate">{subtitle}</div>}
      </div>

      <div className="shrink-0 text-right">
        <div className="text-[11.5px] text-faint tabular-nums">{fmtRelative(entry.at, now)}</div>
        {entry.source && (
          <div className="text-[10.5px] mt-0.5 truncate max-w-[9rem] text-faint/70">
            {entry.source}
          </div>
        )}
      </div>
    </div>
  )
}
