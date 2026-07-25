import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Disc3, History, Music, Radio, Trash2 } from 'lucide-react'
import { recentMatchesPlayState, type RecentTrack } from '@shared/ipc'
import { useStore } from '@/store'
import { Eqbars } from '@/components/Eqbars'
import { EmptyState } from '@/components/EmptyState'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { Segmented } from '@/components/Segmented'
import { ArtImage } from '@/components/ArtImage'
import { cx, fmtDayBucket, fmtRelative, matchesFilter } from '@/lib/format'
import { clearRecentsWithUndo } from '@/lib/recents'
import { FilterInput } from '@/components/FilterInput'

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
  const saveSettings = useStore((s) => s.saveSettings)
  const grouped = useStore((s) => s.settings.recentsGrouped)
  const playState = useStore((s) => s.playState)
  const filter = useStore((s) => s.screenFilters['recently-played'])
  const setScreenFilter = useStore((s) => s.setScreenFilter)

  // Filter entries BEFORE session/day grouping so groups rebuild from matches.
  const shownRecents = useMemo(
    () =>
      filter
        ? recents.filter((e) =>
            matchesFilter(filter, [e.title, e.artist, e.album, e.station, e.source])
          )
        : recents,
    [recents, filter]
  )

  // The head entry is "live" while it's what's actually sounding right now.
  const state = playState?.state
  const headIsLive =
    shownRecents.length > 0 &&
    (state === 'play' || state === 'buffering') &&
    recentMatchesPlayState(shownRecents[0], playState)

  const scrollRef = useScrollMemory('recently-played')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (recents.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [recents.length])

  const blocks = useMemo(() => buildBlocks(shownRecents), [shownRecents])

  // Day-bucket the blocks by their newest entry.
  const days: Array<{ label: string; blocks: Block[] }> = []
  for (const b of blocks) {
    const label = fmtDayBucket(b.entries[0].at, now)
    const last = days[days.length - 1]
    if (last && last.label === label) last.blocks.push(b)
    else days.push({ label, blocks: [b] })
  }

  const toggleGrouped = (next: boolean): void => {
    void saveSettings({ recentsGrouped: next })
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
        <h1 className="font-display screen-title font-bold text-[26px] tracking-tight">Recently Played</h1>
        <div className="flex-1" />
        {recents.length > 0 && (
          <>
            <FilterInput
              value={filter}
              onChange={(t) => setScreenFilter('recently-played', t)}
              shown={shownRecents.length}
              total={recents.length}
            />
            <Segmented<boolean>
              value={grouped}
              onChange={toggleGrouped}
              options={[
                { value: true, label: 'Grouped' },
                { value: false, label: 'All songs' }
              ]}
            />
            <button
              onClick={() => void clearRecentsWithUndo()}
              data-tip="Clear history"
              aria-label="Clear history"
              className="no-drag flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-[12.5px] text-dim
                         hover:text-alert hover:ring-edge2 hover:bg-raised/70 transition-all"
            >
              <Trash2 size={14} strokeWidth={1.8} />
              Clear
            </button>
          </>
        )}
      </header>

      {recents.length === 0 ? (
        <EmptyState
          icon={History}
          title="No history yet"
          caption="Tracks and stations you play will collect here — a local log, kept only on this computer."
        />
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 pb-8 pt-1">
          <div className="max-w-2xl space-y-6">
            {days.length === 0 && (
              <div className="text-[15px] text-faint pt-6 px-1">No matches for “{filter}”</div>
            )}
            {days.map((day) => (
              <div key={day.label}>
                <div className="microlabel mb-2 px-1">{day.label}</div>
                <div className="space-y-1 divide-y divide-edge/50">
                  {day.blocks.map((block) =>
                    grouped && block.session != null ? (
                      <SessionRow
                        key={block.id}
                        block={block}
                        now={now}
                        live={headIsLive && block === blocks[0]}
                        expanded={expanded.has(block.id)}
                        onToggle={() => toggleExpand(block.id)}
                      />
                    ) : (
                      // Discrete track, or "All songs" mode: one row per entry.
                      block.entries.map((entry, i) => (
                        <TrackRow
                          key={`${block.id}-${i}`}
                          entry={entry}
                          now={now}
                          live={headIsLive && block === blocks[0] && i === 0}
                        />
                      ))
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="microlabel mt-6 px-1">up to 200 entries · stored locally · clears on demand</div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------- row pieces

function Thumb({ entry }: { entry: RecentTrack }): React.JSX.Element {
  const Fallback = entry.isRadio ? Radio : Disc3
  return (
    <div className="h-11 w-11 shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
      <ArtImage src={entry.artUrl} lazy fallback={<Fallback size={17} className="text-faint" />} />
    </div>
  )
}

function TrackRow({
  entry,
  now,
  live
}: {
  entry: RecentTrack
  now: number
  live?: boolean
}): React.JSX.Element {
  const title = entry.isRadio ? (entry.station ?? entry.title) : entry.title
  // Queue-row anatomy: title up top, artist — album below (songText would
  // repeat the title in the subtitle).
  const subtitle = entry.isRadio
    ? entry.title
    : [entry.artist, entry.album].filter(Boolean).join(' — ') || null
  return (
    <div
      data-recent-row="track"
      className={cx(
        'flex items-center gap-4 rounded-xl px-3 py-2.5',
        live ? 'row-playing bg-gold/10' : 'ring-1 ring-edge bg-panel/60'
      )}
    >
      <Thumb entry={entry} />
      <div className="min-w-0 flex-1">
        <div className={cx('flex items-center gap-2 text-[13.5px] truncate', live ? 'text-gold' : 'text-ink')}>
          {live && <Eqbars playing />}
          <span className="truncate">{title ?? '—'}</span>
        </div>
        {subtitle && <div className="text-[12px] text-dim truncate">{subtitle}</div>}
      </div>
      <RightMeta at={entry.at} now={now} source={entry.source} live={live} />
    </div>
  )
}

function SessionRow({
  block,
  now,
  live,
  expanded,
  onToggle
}: {
  block: Block
  now: number
  live?: boolean
  expanded: boolean
  onToggle(): void
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
        onClick={expandable ? onToggle : undefined}
        className={cx(
          'flex items-center gap-4 rounded-xl px-3 py-2.5',
          live ? 'row-playing bg-gold/10' : 'ring-1 ring-edge bg-panel/60',
          expandable && 'cursor-pointer transition-colors',
          expandable && !live && 'hover:bg-raised/70 hover:ring-edge2'
        )}
      >
        <div className="h-11 w-11 shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
          <ArtImage
            src={head.artUrl}
            lazy
            fallback={<FallbackIcon size={17} className="text-faint" />}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className={cx('flex items-center gap-2 text-[13.5px] truncate', live ? 'text-gold' : 'text-ink')}>
            {live && <Eqbars playing />}
            <span className="truncate">{primary ?? '—'}</span>
          </div>
          {subtitle && <div className="text-[12px] text-dim truncate">{subtitle}</div>}
        </div>
        {/* Suppress the right-hand source when it just repeats the primary line (streams). */}
        <RightMeta at={head.at} now={now} source={head.source === primary ? null : head.source} live={live} />
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
            <ChevronRight size={16} className={cx('transition-transform', expanded && 'rotate-90')} />
          </button>
        )}
      </div>

      {expandable && expanded && (
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
  source,
  live
}: {
  at: number
  now: number
  source: string | null
  live?: boolean
}): React.JSX.Element {
  return (
    <div className="shrink-0 text-right">
      <div className={cx('text-[11.5px] tabular-nums', live ? 'text-gold/80' : 'text-faint')}>
        {live ? 'now' : fmtRelative(at, now)}
      </div>
      {source && <div className="text-[10.5px] mt-0.5 truncate max-w-[9rem] text-faint/70">{source}</div>}
    </div>
  )
}
