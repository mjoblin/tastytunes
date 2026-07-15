import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Disc3, History, Music, Play, Radio, Trash2 } from 'lucide-react'
import type { RecentTrack } from '@shared/ipc'
import type { QueueListItem } from '@shared/smoip'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { cx, fmtDayBucket, fmtRelative } from '@/lib/format'

interface Block {
  session: string | null
  /** Newest-first, songless rows already hidden when the block has real songs. */
  entries: RecentTrack[]
  id: string
}

/** Partition the newest-first log into session blocks, hiding songless noise. */
function buildBlocks(recents: RecentTrack[]): Block[] {
  const blocks: Block[] = []
  for (const e of recents) {
    const last = blocks[blocks.length - 1]
    // Only continuous sessions (non-null session) absorb consecutive entries;
    // discrete queued tracks (session null) each stand alone.
    if (last && last.session != null && last.session === e.session) last.entries.push(e)
    else blocks.push({ session: e.session, entries: [e], id: '' })
  }
  for (const b of blocks) {
    const hasSong = b.entries.some((e) => e.title != null)
    b.entries = hasSong ? b.entries.filter((e) => e.title != null) : [b.entries[0]]
    b.id = `${b.session ?? 'd'}@${b.entries[b.entries.length - 1].at}`
  }
  return blocks
}

const songText = (e: RecentTrack): string | null =>
  e.isRadio ? e.title : [e.title, e.artist].filter(Boolean).join(' — ') || null

/** Read-only local history of tracks the streamer has played. */
export function RecentlyPlayedScreen(): React.JSX.Element {
  const recents = useStore((s) => s.recents)
  const grouped = useStore((s) => s.settings.recentsGrouped)
  const setSettings = useStore((s) => s.setSettings)
  const connection = useStore((s) => s.connection)
  const systemPower = useStore((s) => s.systemPower)
  const presets = useStore((s) => s.presets)
  const queue = useStore((s) => s.queue)

  const scrollRef = useScrollMemory('recently-played')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (recents.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [recents.length])

  const connectedAwake = connection.phase === 'connected' && systemPower?.power === 'ON'

  // Index the current queue so a local row can find its track (by stable id, or
  // by song if the id has since moved) to replay it.
  const queueIndex = useMemo(() => {
    const byId = new Map<number, QueueListItem>()
    const bySong = new Map<string, QueueListItem>()
    for (const item of queue?.items ?? []) {
      if (item.id != null) byId.set(item.id, item)
      const key = `${item.metadata?.title ?? ''}|${item.metadata?.artist ?? ''}`
      if (!bySong.has(key)) bySong.set(key, item)
    }
    return { byId, bySong }
  }, [queue])

  const queueItemFor = (e: RecentTrack): QueueListItem | null => {
    if (e.session != null) return null // only discrete local tracks live in the queue
    const byId = e.queueId != null ? queueIndex.byId.get(e.queueId) : undefined
    if (byId && (byId.metadata?.title ?? null) === e.title) return byId
    return queueIndex.bySong.get(`${e.title ?? ''}|${e.artist ?? ''}`) ?? null
  }

  // A continuous source can always be re-activated (switch source / recall
  // preset); a local track only if it's still sitting in the queue.
  const canActivate = (e: RecentTrack): boolean => {
    if (!connectedAwake) return false
    if (e.session != null) return true
    return queueItemFor(e) != null
  }

  const activate = (e: RecentTrack): void => {
    if (!canActivate(e)) return
    if (e.isRadio) {
      const preset = presets?.presets?.find(
        (p) =>
          (e.radioId != null && p.airable_radio_id === e.radioId) ||
          (!!p.name && !!e.station && p.name.trim().toLowerCase() === e.station.trim().toLowerCase())
      )
      if (preset?.id != null) {
        void tt.command({ type: 'recallPreset', presetId: preset.id })
        return
      }
    }
    if (e.session != null) {
      if (e.sourceId) void tt.command({ type: 'setSource', sourceId: e.sourceId })
      return
    }
    // Discrete local track: actually play it from the queue (setSource alone only
    // re-selects the parked track without starting playback).
    const item = queueItemFor(e)
    if (item?.id != null) void tt.command({ type: 'playQueueId', queueId: item.id })
  }

  const blocks = useMemo(() => buildBlocks(recents), [recents])

  // Day-bucket the blocks by their newest entry.
  const days: Array<{ label: string; blocks: Block[] }> = []
  for (const b of blocks) {
    const label = fmtDayBucket(b.entries[0].at, now)
    const last = days[days.length - 1]
    if (last && last.label === label) last.blocks.push(b)
    else days.push({ label, blocks: [b] })
  }

  const toggleGrouped = (next: boolean): void => {
    void tt.setSettings({ recentsGrouped: next }).then(setSettings)
  }
  const toggleExpand = (id: string): void =>
    setExpanded((prev) => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-3 px-8 pt-8 pb-4">
        <h1 className="font-display font-bold text-[26px] tracking-tight">Recently Played</h1>
        <div className="flex-1" />
        {recents.length > 0 && (
          <>
            <div className="no-drag flex rounded-lg ring-1 ring-edge bg-bg/70 p-0.5">
              {[
                { on: true, label: 'Grouped' },
                { on: false, label: 'All songs' }
              ].map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => toggleGrouped(opt.on)}
                  className={cx(
                    'px-3 py-1.5 rounded-md text-[12px] transition-colors',
                    grouped === opt.on ? 'bg-golddim text-gold' : 'text-dim hover:text-ink'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => void tt.clearRecents()}
              data-tip="Clear history"
              aria-label="Clear history"
              className="no-drag flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-edge text-[12.5px] text-dim
                         hover:text-alert hover:ring-edge2 transition-all"
            >
              <Trash2 size={14} strokeWidth={1.8} />
              Clear
            </button>
          </>
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
            {days.map((day) => (
              <div key={day.label}>
                <div className="microlabel mb-2 px-1">{day.label}</div>
                <div className="space-y-1">
                  {day.blocks.map((block) =>
                    grouped && block.session != null ? (
                      <SessionRow
                        key={block.id}
                        block={block}
                        now={now}
                        canActivate={canActivate(block.entries[0])}
                        expanded={expanded.has(block.id)}
                        onToggle={() => toggleExpand(block.id)}
                        onPlay={() => activate(block.entries[0])}
                      />
                    ) : (
                      // Discrete track, or "All songs" mode: one row per entry.
                      block.entries.map((entry, i) => (
                        <TrackRow
                          key={`${block.id}-${i}`}
                          entry={entry}
                          now={now}
                          canActivate={canActivate(entry)}
                          onPlay={() => activate(entry)}
                        />
                      ))
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="microlabel mt-6 px-1">
            up to 200 entries · stored locally ·{' '}
            {connectedAwake ? 'click a row to play it' : 'clears on demand'}
          </div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------- row pieces

function Thumb({
  entry,
  canActivate
}: {
  entry: RecentTrack
  canActivate: boolean
}): React.JSX.Element {
  const Fallback = entry.isRadio ? Radio : Disc3
  return (
    <div className="relative h-11 w-11 shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
      {entry.artUrl ? (
        <img src={entry.artUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <Fallback size={17} className="text-faint" />
      )}
      {canActivate && (
        <span className="absolute inset-0 hidden group-hover:flex items-center justify-center bg-black/55">
          <Play size={16} className="text-ink" fill="currentColor" />
        </span>
      )}
    </div>
  )
}

function TrackRow({
  entry,
  now,
  canActivate,
  onPlay
}: {
  entry: RecentTrack
  now: number
  canActivate: boolean
  onPlay(): void
}): React.JSX.Element {
  const title = entry.isRadio ? (entry.station ?? entry.title) : entry.title
  const subtitle = entry.isRadio ? entry.title : songText(entry)
  return (
    <div
      data-recent-row="track"
      onClick={canActivate ? onPlay : undefined}
      className={cx(
        'group flex items-center gap-4 rounded-xl px-3 py-2.5 ring-1 ring-edge bg-panel/60',
        canActivate && 'cursor-pointer hover:bg-raised/70 hover:ring-edge2 transition-colors'
      )}
    >
      <Thumb entry={entry} canActivate={canActivate} />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-ink truncate">{title ?? '—'}</div>
        {subtitle && <div className="text-[12px] text-dim truncate">{subtitle}</div>}
      </div>
      <RightMeta at={entry.at} now={now} source={entry.source} />
    </div>
  )
}

function SessionRow({
  block,
  now,
  canActivate,
  expanded,
  onToggle,
  onPlay
}: {
  block: Block
  now: number
  canActivate: boolean
  expanded: boolean
  onToggle(): void
  onPlay(): void
}): React.JSX.Element {
  const head = block.entries[0]
  const songs = block.entries.filter((e) => e.title != null)
  const primary = head.isRadio ? (head.station ?? head.source) : (head.source ?? head.station)
  const latest = songText(songs[0] ?? head)
  const subtitle =
    songs.length > 1 ? `${latest} · ${songs.length} songs` : (latest ?? (head.isRadio ? 'Live' : null))
  // Expandable whenever there's at least one song, so a single-song session
  // lists its song the same way a multi-song one does.
  const expandable = songs.length >= 1
  const FallbackIcon = head.isRadio ? Radio : Music

  return (
    <div>
      <div
        data-recent-row="session"
        onClick={canActivate ? onPlay : undefined}
        className={cx(
          'group flex items-center gap-4 rounded-xl px-3 py-2.5 ring-1 ring-edge bg-panel/60',
          canActivate && 'cursor-pointer hover:bg-raised/70 hover:ring-edge2 transition-colors'
        )}
      >
        <div className="relative h-11 w-11 shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
          {head.artUrl ? (
            <img src={head.artUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <FallbackIcon size={17} className="text-faint" />
          )}
          {canActivate && (
            <span className="absolute inset-0 hidden group-hover:flex items-center justify-center bg-black/55">
              <Play size={16} className="text-ink" fill="currentColor" />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] text-ink truncate">{primary ?? '—'}</div>
          {subtitle && <div className="text-[12px] text-dim truncate">{subtitle}</div>}
        </div>
        {/* Suppress the right-hand source when it just repeats the primary line (streams). */}
        <RightMeta at={head.at} now={now} source={head.source === primary ? null : head.source} />
        {expandable && (
          <button
            onClick={(ev) => {
              ev.stopPropagation()
              onToggle()
            }}
            data-tip={expanded ? 'Hide songs' : 'Show songs'}
            aria-label={expanded ? 'Hide songs' : 'Show songs'}
            className="shrink-0 p-1 rounded text-faint hover:text-ink transition-colors"
          >
            <ChevronRight
              size={16}
              className={cx('transition-transform', expanded && 'rotate-90')}
            />
          </button>
        )}
      </div>

      {expandable && expanded && (
        // Songs within a continuous session aren't individually replayable — the
        // session header plays it. Kept hover-highlighted but not clickable.
        <div className="mt-1 ml-6 pl-4 border-l border-edge space-y-1">
          {songs.map((entry, i) => (
            <div
              key={`${block.id}-song-${i}`}
              data-recent-song
              className="flex items-center gap-3 rounded-lg px-3 py-1.5 hover:bg-veil transition-colors"
            >
              <span className="font-mono text-[10px] text-faint/70 w-4 shrink-0 tabular-nums">
                {songs.length - i}
              </span>
              <div className="min-w-0 flex-1 text-[12.5px] text-dim truncate">{songText(entry)}</div>
              <span className="shrink-0 text-[11px] text-faint tabular-nums">
                {fmtRelative(entry.at, now)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RightMeta({
  at,
  now,
  source
}: {
  at: number
  now: number
  source: string | null
}): React.JSX.Element {
  return (
    <div className="shrink-0 text-right">
      <div className="text-[11.5px] text-faint tabular-nums">{fmtRelative(at, now)}</div>
      {source && <div className="text-[10.5px] mt-0.5 truncate max-w-[9rem] text-faint/70">{source}</div>}
    </div>
  )
}
