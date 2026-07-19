import { useEffect, useRef, useState } from 'react'
import { BookmarkPlus, RadioTower, RotateCw, Search, X } from 'lucide-react'
import type { RadioStation } from '@shared/ipc'
import { isRadioMetadata } from '@shared/smoip'
import { tt } from '@/api'
import { useStore } from '@/store'
import { ArtImage } from '@/components/ArtImage'
import { EmptyState } from '@/components/EmptyState'
import { Eqbars } from '@/components/Eqbars'
import { PresetSavePanel } from '@/components/LibraryMenus'
import { useClampedPosition, usePopoverChrome } from '@/hooks/usePopover'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { cx } from '@/lib/format'
import { createPortal } from 'react-dom'

/**
 * Internet radio via the radio-browser.info community directory (keyless —
 * lookups run in the main process for the identifying User-Agent and the
 * renderer CSP). Play is device-native: /stream/radio with the station's
 * stream URL, so the streamer does the playing and any controller sees it.
 * Saving uses /zone/save_preset, which snapshots CURRENT playback — that's
 * why the save affordance lives on the playing station's row only.
 */

// Session-scoped like scrollMemory: coming back to the screen restores the
// last search instead of refetching the default rail.
let lastQuery = ''
let lastResults: RadioStation[] | null = null
let topCache: RadioStation[] | null = null

const DEBOUNCE_MS = 350

export function RadioScreen(): React.JSX.Element {
  const playState = useStore((s) => s.playState)
  const showToast = useStore((s) => s.showToast)

  const [query, setQuery] = useState(lastQuery)
  const [top, setTop] = useState<RadioStation[] | null>(topCache)
  const [results, setResults] = useState<RadioStation[] | null>(lastQuery ? lastResults : null)
  const [searching, setSearching] = useState(false)
  const [topFailed, setTopFailed] = useState(false)
  const [saveFor, setSaveFor] = useState<{ station: RadioStation; x: number; y: number } | null>(
    null
  )
  const scrollRef = useScrollMemory('radio')

  // The default rail, fetched once per app session.
  const loadTop = async (): Promise<void> => {
    setTopFailed(false)
    const stations = await tt.radioTop()
    topCache = stations
    setTop(stations)
    if (stations.length === 0) setTopFailed(true)
  }
  useEffect(() => {
    if (topCache == null) void loadTop()
  }, [])

  // Debounced live search; empty query falls back to the rail.
  const searchSeq = useRef(0)
  useEffect(() => {
    lastQuery = query
    const q = query.trim()
    if (!q) {
      lastResults = null
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const seq = ++searchSeq.current
    const t = setTimeout(async () => {
      const stations = await tt.radioSearch(q)
      if (seq !== searchSeq.current) return // superseded by newer keystrokes
      lastResults = stations
      setResults(stations)
      setSearching(false)
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  // The station whose stream the device is playing right now — name-matched,
  // the same identity radio presets use (play_state has no stream URL).
  const md = playState?.metadata
  const playingName =
    isRadioMetadata(md) && (playState?.state === 'play' || playState?.state === 'buffering')
      ? (md?.station ?? md?.name)?.trim().toLowerCase()
      : null

  const play = async (st: RadioStation): Promise<void> => {
    // failure is toasted by the api layer; success shows in the row + bar
    await tt.command({ type: 'streamRadio', url: st.url, name: st.name }).catch(() => {})
  }

  const savePlaying = async (slot: number, name: string | null): Promise<void> => {
    await tt.command({ type: 'zoneSavePreset', slot })
    if (name) await tt.command({ type: 'presetRename', slot, name })
    const station = saveFor?.station
    setSaveFor(null)
    showToast({
      kind: 'success',
      text: `Saved “${name ?? station?.name ?? 'station'}” to preset ${slot}`,
      action: { label: 'View', screen: 'presets' }
    })
  }

  const shown = results ?? top
  const heading = results != null ? 'Search results' : 'Popular stations'

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-3 px-8 pt-8 pb-4">
        <h1 className="font-display font-bold text-[26px] tracking-tight">Radio</h1>
        <div className="flex-1" />
        <div className="no-drag relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              }
            }}
            placeholder="Search stations"
            aria-label="Search stations"
            className="w-64 bg-bg rounded-lg ring-1 ring-edge focus:ring-edge2 outline-none pl-9 pr-8 py-1.5 text-[13px] placeholder:text-faint"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded-full text-faint hover:text-ink transition-colors"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </header>

      {shown == null ? (
        topFailed ? (
          <EmptyState
            icon={RadioTower}
            title="Station directory unreachable"
            caption="radio-browser.info didn't answer — check the connection and retry."
          >
            <button
              onClick={() => void loadTop()}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-[12.5px] text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 transition-all"
            >
              <RotateCw size={13} /> Retry
            </button>
          </EmptyState>
        ) : (
          <div className="px-9 pt-4 text-[13px] text-dim motion-safe:animate-pulse">
            Loading stations…
          </div>
        )
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 pb-8 pt-1">
          <div className="max-w-2xl">
            <div className="microlabel mb-2 px-1 flex items-center gap-2">
              {heading}
              {searching && <span className="motion-safe:animate-pulse">searching…</span>}
            </div>
            {shown.length === 0 && !searching && (
              <div className="text-[15px] text-faint pt-4 px-1">No stations for “{query}”</div>
            )}
            <div className="space-y-1 divide-y divide-edge/50">
              {shown.map((st) => {
                const playing = playingName != null && st.name.trim().toLowerCase() === playingName
                return (
                  <StationRow
                    key={st.uuid}
                    station={st}
                    playing={playing}
                    onPlay={() => void play(st)}
                    onSave={(x, y) => setSaveFor({ station: st, x, y })}
                  />
                )
              })}
            </div>
            <div className="microlabel mt-6 px-1">
              stations from radio-browser.info · community directory
            </div>
          </div>
        </div>
      )}

      {saveFor && (
        <SaveStationPopover
          x={saveFor.x}
          y={saveFor.y}
          station={saveFor.station}
          onClose={() => setSaveFor(null)}
          onSave={savePlaying}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------- row pieces

function StationRow({
  station,
  playing,
  onPlay,
  onSave
}: {
  station: RadioStation
  playing: boolean
  onPlay(): void
  onSave(x: number, y: number): void
}): React.JSX.Element {
  const tags = station.tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ')
  const subtitle = [tags, station.country].filter(Boolean).join(' — ')
  const quality = [station.codec, station.bitrate > 0 ? `${station.bitrate}k` : null]
    .filter(Boolean)
    .join(' ')
  return (
    <div
      data-radio-row
      onClick={onPlay}
      className={cx(
        'flex items-center gap-4 rounded-xl px-3 py-2.5 cursor-pointer transition-colors',
        playing ? 'row-playing bg-gold/10' : 'ring-1 ring-edge bg-panel/60 hover:bg-raised/70 hover:ring-edge2'
      )}
    >
      <div className="h-11 w-11 shrink-0 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        <ArtImage
          src={station.favicon}
          lazy
          fallback={<RadioTower size={17} className="text-faint" />}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cx(
            'flex items-center gap-2 text-[13.5px] truncate',
            playing ? 'text-gold' : 'text-ink'
          )}
        >
          {playing && <Eqbars playing />}
          <span className="truncate">{station.name}</span>
        </div>
        {subtitle && <div className="text-[12px] text-dim truncate">{subtitle}</div>}
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {quality && <span className="text-[10.5px] text-faint/70 font-mono uppercase">{quality}</span>}
        {playing && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              onSave(r.left, r.bottom + 6)
            }}
            data-tip="Save station to preset"
            aria-label="Save station to preset"
            className="p-1.5 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
          >
            <BookmarkPlus size={16} />
          </button>
        )}
      </div>
    </div>
  )
}

/** The shared PresetSavePanel in an anchored popover next to the save button. */
function SaveStationPopover({
  x,
  y,
  station,
  onClose,
  onSave
}: {
  x: number
  y: number
  station: RadioStation
  onClose(): void
  onSave(slot: number, name: string | null): Promise<void>
}): React.JSX.Element {
  usePopoverChrome(onClose)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pos = useClampedPosition(boxRef, x, y)
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={boxRef}
        className="fixed z-50 w-[272px] rounded-xl ring-1 ring-edge2 bg-raised shadow-xl p-3"
        style={pos}
      >
        <PresetSavePanel
          title={station.name}
          subtitle="Saves what's playing on the streamer"
          onSave={onSave}
        />
      </div>
    </>,
    document.body
  )
}
