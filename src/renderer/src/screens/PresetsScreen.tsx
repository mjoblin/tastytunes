import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Crosshair,
  Footprints,
  GripVertical,
  LayoutGrid,
  Play,
  Radio,
  Rows3,
  Trash2,
  Volume2
} from 'lucide-react'
import type { PresetItem } from '@shared/smoip'
import { presetVolumeKey, type ScreenLayout } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { flashTarget, scrollToWithContext } from '@/lib/scroll'
import { cx, matchesFilter } from '@/lib/format'
import { FilterInput } from '@/components/FilterInput'
import { Slider } from '@/components/Slider'
import { ArtImage } from '@/components/ArtImage'

export function PresetsScreen(): React.JSX.Element {
  const presets = useStore((s) => s.presets)
  const playState = useStore((s) => s.playState)
  const zoneState = useStore((s) => s.zoneState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const { presetCardSize, presetGap, presetFillRows, followPresets, presetsLayout } = useStore(
    (s) => s.settings
  )
  const setSettings = useStore((s) => s.setSettings)
  const systemInfo = useStore((s) => s.systemInfo)
  const presetVolumes = useStore((s) => s.settings.presetVolumes)
  const cards = presetsLayout === 'cards'
  const filter = useStore((s) => s.screenFilters.presets)
  const setScreenFilter = useStore((s) => s.setScreenFilter)
  const allItems = (presets?.presets ?? []).filter((p) => p.id != null)
  // type/class are hidden fields but filterable: "radio" / "media" work.
  const items = filter
    ? allItems.filter((p) => matchesFilter(filter, [p.name, p.type, p.class]))
    : allItems

  // Feature 10: per-preset volume overrides. Absolute volume needs pre-amp
  // mode — control-bus devices only nudge, so the affordance hides there.
  const canSetVolume = zoneState?.pre_amp_mode === true
  const volumeFor = (id: number): number | null =>
    presetVolumes[presetVolumeKey(systemInfo?.udn, id)] ?? null
  const saveVolume = async (id: number, level: number | null): Promise<void> => {
    const key = presetVolumeKey(systemInfo?.udn, id)
    const next = { ...presetVolumes }
    if (level == null) delete next[key]
    else next[key] = level
    setSettings(await tt.setSettings({ presetVolumes: next }))
  }
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  // The streamer's is_playing flags can't be trusted:
  //  - radio presets aren't cleared when switching to local media (vibin's
  //    _fix_stale_preset_is_playing), and
  //  - media (album) presets only report is_playing transiently around the
  //    recall — any later read returns false (vibinui's own TODO: "When the UI
  //    is refreshed, a stream.media.upnp preset will have an is_playing of
  //    false, even if it was playing").
  // So derive the playing preset statelessly from what's actually playing:
  // radio_id is authoritative for stations; album presets are matched by art
  // URL or name against the current track. Stateless means it also works at
  // startup, when every flag reads false.
  const activeSourceId = zoneState?.source ?? nowPlaying?.source?.id ?? null
  const radioId = playState?.metadata?.radio_id ?? null
  const md = playState?.metadata ?? null
  const isPresetPlaying = (p: PresetItem): boolean => {
    if (radioId != null && p.airable_radio_id != null) return p.airable_radio_id === radioId
    const klass = p.class ?? ''
    if (klass.startsWith('stream.media')) {
      if (activeSourceId != null && activeSourceId !== 'MEDIA_PLAYER') return false
      if (p.is_playing === true) return true // transiently correct after recall
      if (!md) return false
      if (p.art_url != null && md.art_url != null && urlsMatch(p.art_url, md.art_url)) return true
      if (p.name != null && md.album != null) {
        if (p.name === md.album) return true
        if (md.artist != null && p.name.includes(md.album) && p.name.includes(md.artist)) return true
      }
      return false
    }
    // Radio/other presets with no playing radio_id to match against: trust the
    // flag except while local media is the active source.
    return p.is_playing === true && activeSourceId !== 'MEDIA_PLAYER'
  }

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    void tt.command({ type: 'presetMove', from: active.id as number, to: over.id as number })
  }

  // Scroll container: combine scroll memory (skipped when following) with a
  // queryable ref for scroll-to-playing.
  const scrollMemory = useScrollMemory('presets', !followPresets)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node
      scrollMemory(node)
    },
    [scrollMemory]
  )
  // Cards get half a card of context above the target; rows get a full row.
  const scrollToPlaying = useCallback(
    (flash = false, behavior?: ScrollBehavior): void => {
      const el = containerRef.current?.querySelector('[data-playing="true"]') as HTMLElement | null
      scrollToWithContext(el, cards ? presetGap : 8, cards ? 0.5 : 1, behavior)
      if (flash) flashTarget(el)
    },
    [presetGap, cards]
  )

  const playingId = items.find(isPresetPlaying)?.id ?? null
  // First follow after mount positions INSTANTLY — re-entering the screen
  // shouldn't replay a glide to a place you already were. The animation is
  // reserved for track changes while you're watching.
  const firstFollow = useRef(true)
  useEffect(() => {
    // Follow pauses while a filter is active — the playing card may be hidden.
    if (followPresets && playingId != null && !filter) {
      scrollToPlaying(false, firstFollow.current ? 'auto' : undefined)
    }
    firstFollow.current = false
  }, [followPresets, playingId, scrollToPlaying, filter])

  const setFollowPresets = async (follow: boolean): Promise<void> => {
    setSettings(await tt.setSettings({ followPresets: follow }))
  }
  const setLayout = async (presetsLayout: ScreenLayout): Promise<void> => {
    setSettings(await tt.setSettings({ presetsLayout }))
  }

  if (allItems.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 text-center px-8">
        <Radio size={56} strokeWidth={1} className="text-faint/50" />
        <div className="font-display text-2xl text-dim">No presets</div>
        <div className="text-[13px] text-faint max-w-sm">
          Save radio stations or albums to preset slots with the StreamMagic app and they'll appear
          here for one-click recall.
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <h1 className="font-display font-bold text-[26px] tracking-tight">Presets</h1>
        <span className="font-mono text-[11px] text-faint">
          {allItems.length} / {presets?.max_presets ?? '—'} slots
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <FilterInput
            value={filter}
            onChange={(t) => setScreenFilter('presets', t)}
            shown={items.length}
            total={allItems.length}
          />
          <button
            data-tip={cards ? 'View as rows' : 'View as cards'}
            aria-label={cards ? 'View as rows' : 'View as cards'}
            onClick={() => void setLayout(cards ? 'rows' : 'cards')}
            className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
          >
            {cards ? <Rows3 size={16} /> : <LayoutGrid size={16} />}
          </button>
          <button
            data-tip="Scroll to the playing preset"
            aria-label="Scroll to the playing preset"
            onClick={() => scrollToPlaying(true)}
            className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
          >
            <Crosshair size={16} />
          </button>
          <button
            data-tip={followPresets ? 'Auto-follow: on' : 'Auto-follow: off'}
            aria-label={followPresets ? 'Auto-follow: on' : 'Auto-follow: off'}
            onClick={() => void setFollowPresets(!followPresets)}
            className={cx(
              'no-drag tip-bottom p-2 rounded-lg ring-1 transition-all',
              followPresets
                ? 'ring-gold/50 bg-golddim text-gold'
                : 'ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70'
            )}
          >
            <Footprints size={16} />
          </button>
        </div>
      </header>

      {/* rows: pt-1 keeps the playing ring unclipped; cards: pt-2 gives the
          hover grow + glow ring headroom on the top row */}
      <div ref={setContainerRef} className={cx('flex-1 overflow-y-auto', cards ? 'px-8 pb-8 pt-2' : 'px-6 pb-6 pt-1 divide-y divide-edge/50')}>
        {items.length === 0 && (
          <div className="text-[13px] text-faint pt-6 px-2">No matches for “{filter}”</div>
        )}
        {/* Reordering a partial list is ambiguous — drags are inert while filtered. */}
        <DndContext
          sensors={filter ? [] : sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={items.map((p) => p.id as number)}
            strategy={cards ? rectSortingStrategy : verticalListSortingStrategy}
          >
            {cards ? (
              <div
                className="grid"
                style={{
                  gridTemplateColumns: presetFillRows
                    ? `repeat(auto-fill, minmax(${presetCardSize}px, 1fr))`
                    : `repeat(auto-fill, ${presetCardSize}px)`,
                  gap: presetGap
                }}
              >
                {items.map((preset) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    playing={isPresetPlaying(preset)}
                    volume={volumeFor(preset.id as number)}
                    canSetVolume={canSetVolume}
                    onVolume={(level) => void saveVolume(preset.id as number, level)}
                  />
                ))}
              </div>
            ) : (
              items.map((preset) => (
                <PresetRow
                  key={preset.id}
                  preset={preset}
                  playing={isPresetPlaying(preset)}
                  volume={volumeFor(preset.id as number)}
                  canSetVolume={canSetVolume}
                  onVolume={(level) => void saveVolume(preset.id as number, level)}
                />
              ))
            )}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  )
}

/** Same art object regardless of scheme/query differences. */
function urlsMatch(a: string, b: string): boolean {
  if (a === b) return true
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.host === ub.host && ua.pathname === ub.pathname
  } catch {
    return false
  }
}

interface PresetVolumeProps {
  /** Saved override, or null. */
  volume: number | null
  /** Pre-amp mode only — control-bus devices can't set an absolute level. */
  canSetVolume: boolean
  onVolume(level: number | null): void
}

/**
 * Feature 10's popover, shared by rows and cards. Renders through a portal:
 * the sortable cards/rows carry a dnd-kit transform, which makes them
 * containing blocks — a position:fixed child would anchor to the CARD, not
 * the viewport. Saving is EXPLICIT: the slider only stages a draft and the
 * gold Set button commits, so clicking away always means "never mind".
 */
function usePresetVolumePopover(
  volume: number | null,
  onVolume: (level: number | null) => void
): { open: boolean; openFrom(e: React.MouseEvent): void; popover: React.ReactNode } {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number } | null>(
    null
  )
  const [draft, setDraft] = useState<number | null>(null)
  const zoneVolume = useStore((s) => s.zoneState?.volume_percent)

  const level = draft ?? volume ?? zoneVolume ?? 25
  const WIDTH = 240 // keep in step with w-60 below

  const openFrom = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (open) {
      setOpen(false)
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    const above = r.top > 300 // flip below the anchor when there's no headroom
    setAnchor({
      // right-aligned to the anchor, clamped into the viewport so the
      // left-most card's popover slides right instead of clipping
      left: Math.min(Math.max(8, r.right - WIDTH), window.innerWidth - WIDTH - 8),
      ...(above ? { bottom: window.innerHeight - r.top + 8 } : { top: r.bottom + 8 })
    })
    setDraft(null)
    setOpen(true)
  }

  const popover =
    open && anchor
      ? createPortal(
          <>
            <span
              data-preset-volume-overlay
              className="fixed inset-0 z-30 cursor-default"
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
              }}
            />
            <span
              data-preset-volume-popover
              style={anchor}
              className="fixed z-40 w-60 rounded-xl bg-raised ring-1 ring-edge2 shadow-2xl p-3 block cursor-default"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className="flex items-center justify-between mb-2">
                <span className="microlabel text-dim">preset volume</span>
                <span className="font-mono text-[11px] text-gold tabular-nums">{level}%</span>
              </span>
              <Slider
                value={level / 100}
                onScrub={(v) => setDraft(Math.round(v * 100))}
                onCancel={() => setDraft(null)}
                onCommit={(v) => setDraft(Math.round(v * 100))}
                ariaLabel="Preset volume"
                thumb="always"
              />
              <span className="block text-[11px] text-faint leading-relaxed mt-2.5">
                TastyTunes sets this volume whenever it starts this preset. Recalls from the
                official app or the streamer itself aren't affected.
              </span>
              <span className="flex items-center gap-2 mt-2.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onVolume(level)
                    setOpen(false)
                  }}
                  className="text-[12px] px-3 py-1 rounded-lg bg-gold text-bg font-medium hover:brightness-110 motion-safe:active:scale-95 transition-all"
                >
                  Set {level}%
                </button>
                {volume != null && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onVolume(null)
                      setOpen(false)
                    }}
                    className="text-[12px] px-2.5 py-1 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-alert hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
                  >
                    Clear
                  </button>
                )}
              </span>
            </span>
          </>,
          document.body
        )
      : null

  return { open, openFrom, popover }
}

/** Row view of a preset — mirrors the queue row's anatomy. */
function PresetRow({
  preset,
  playing,
  volume,
  canSetVolume,
  onVolume
}: { preset: PresetItem; playing: boolean } & PresetVolumeProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: preset.id as number
  })
  const [confirmDelete, setConfirmDelete] = useState(false)
  const pv = usePresetVolumePopover(volume, onVolume)

  useEffect(() => {
    if (!confirmDelete) return
    const t = setTimeout(() => setConfirmDelete(false), 3000)
    return () => clearTimeout(t)
  }, [confirmDelete])

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-playing={playing || undefined}
      className={cx(
        'group grid grid-cols-[26px_44px_1fr_auto_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5',
        'cursor-default transition-colors',
        isDragging && 'z-10 bg-raised shadow-xl',
        // hold the hover highlight while this row's volume popover is open —
        // the pointer leaves the row, but the row is still what's being edited
        playing ? 'row-playing bg-gold/10' : pv.open ? 'bg-veil' : 'hover:bg-veil'
      )}
      onClick={() => {
        if (preset.id != null) void tt.command({ type: 'recallPreset', presetId: preset.id })
      }}
    >
      <div className="flex items-center justify-center">
        {playing ? (
          <span className="eqbars text-gold">
            <span style={{ height: 6 }} />
            <span style={{ height: 10 }} />
            <span style={{ height: 5 }} />
          </span>
        ) : (
          <span className="font-mono text-[10.5px] text-faint tabular-nums">
            {String(preset.id).padStart(2, '0')}
          </span>
        )}
      </div>

      <div className="h-10 w-10 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        <ArtImage src={preset.art_url} lazy fallback={<Radio size={16} className="text-faint" />} />
      </div>

      <div className="min-w-0">
        <div className={cx('text-[13.5px] truncate', playing ? 'text-gold' : 'text-ink')}>
          {preset.name ?? `Preset ${preset.id}`}
        </div>
        <div className="text-[12px] text-dim truncate">
          {preset.class ? preset.class.replace(/^stream\./, '') : ''}
        </div>
      </div>

      <span className="inline-flex" onPointerDown={(e) => e.stopPropagation()}>
        {volume != null ? (
          <button
            data-tip={`Recalled at ${volume}% volume`}
          aria-label="Preset volume"
            onClick={pv.openFrom}
            data-preset-volume-badge
            className="tip-bottom flex items-center gap-1 p-1 rounded font-mono text-[10px] text-faint hover:text-ink transition-colors tabular-nums"
          >
            <Volume2 size={11} />
            {volume}%
          </button>
        ) : canSetVolume ? (
          <button
            data-tip="Preset volume"
            aria-label="Preset volume"
            onClick={pv.openFrom}
            data-preset-volume
            className={cx(
              'tip-bottom p-1.5 rounded text-faint hover:text-ink transition-all',
              pv.open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <Volume2 size={13} />
          </button>
        ) : null}
        {pv.popover}
      </span>

      <button
        data-tip={confirmDelete ? 'Click again to delete' : 'Delete preset'}
        aria-label="Delete preset"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          if (!confirmDelete) {
            setConfirmDelete(true)
          } else if (preset.id != null) {
            setConfirmDelete(false)
            void tt.command({ type: 'presetDelete', presetId: preset.id })
          }
        }}
        className={cx(
          'tip-bottom flex items-center gap-1.5 p-1.5 rounded transition-all',
          confirmDelete
            ? 'bg-alert text-white opacity-100 px-2'
            : 'text-faint opacity-0 group-hover:opacity-100 hover:text-alert'
        )}
      >
        <Trash2 size={13} />
        {confirmDelete && (
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wide">sure?</span>
        )}
      </button>

      <button
        title="Drag to reorder"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="p-1 rounded text-faint opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </button>
    </div>
  )
}

function PresetCard({
  preset,
  playing,
  volume,
  canSetVolume,
  onVolume
}: { preset: PresetItem; playing: boolean } & PresetVolumeProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: preset.id as number
  })
  const [confirmDelete, setConfirmDelete] = useState(false)
  const pv = usePresetVolumePopover(volume, onVolume)

  useEffect(() => {
    if (!confirmDelete) return
    const t = setTimeout(() => setConfirmDelete(false), 3000)
    return () => clearTimeout(t)
  }, [confirmDelete])

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      data-playing={playing || undefined}
      className={cx(
        // Inset tile: the gold highlight wraps the gray tile, never the art, so
        // it stays legible on gold/orange album covers.
        // Hover: a slight grow + lift (scale is layout-free, so edge-clipped
        // cards just clip at the scrollport; z-10 keeps the grown card on top).
        'group relative text-left rounded-2xl p-2 pb-2.5 transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]',
        isDragging && 'z-10 opacity-90',
        playing ? 'bg-goldtile/70 tile-playing' : 'bg-raised/70 ring-1 ring-edge card-hover-glow',
        // held while this card's volume popover is open — the pointer has left,
        // but the card is still what's being edited
        pv.open && 'ring-1 ring-edge2'
      )}
    >
      {/* relative wrapper bounds exactly the art, so the corner chips anchor
          to the artwork: playing top-left, volume-set bottom-left, hover
          speaker top-right, hover trash bottom-right */}
      <div className="relative">
      <button
        className="relative block w-full cursor-pointer"
        onClick={() => {
          if (preset.id != null) void tt.command({ type: 'recallPreset', presetId: preset.id })
        }}
      >
        <div className="aspect-square w-full rounded-lg overflow-hidden bg-panel/70 flex items-center justify-center">
          <ArtImage
            src={preset.art_url}
            lazy
            fallback={<Radio size={34} strokeWidth={1.2} className="text-faint" />}
          />

          {/* hover overlay — the whole card recalls the preset; the chip is the affordance */}
          <div className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <span
              className="h-11 w-11 rounded-full bg-amber text-bg flex items-center justify-center
                         transition-all duration-150 motion-safe:hover:scale-110
                         hover:shadow-[0_0_24px_rgb(var(--amber-rgb)_/_0.6)]"
            >
              <Play size={18} fill="currentColor" strokeWidth={0} className="translate-x-[1px]" />
            </span>
          </div>

          {playing && (
            // h/w match the corner buttons so the four corners feel weighted
            <span className="absolute top-2 left-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/55 backdrop-blur-sm">
              <span className="eqbars text-gold">
                <span style={{ height: 6 }} />
                <span style={{ height: 10 }} />
                <span style={{ height: 5 }} />
              </span>
            </span>
          )}
        </div>
      </button>

      {/* ONE speaker: hover-revealed control normally; when a volume is set it
          stays visible in gold — presence + color IS the indicator, and the
          tooltip carries the percentage */}
      {(canSetVolume || volume != null) && (
        <button
          data-tip={volume != null ? `Recalled at ${volume}% volume` : 'Preset volume'}
          aria-label="Preset volume"
          onClick={pv.openFrom}
          onPointerDown={(e) => e.stopPropagation()}
          data-preset-volume
          className={cx(
            'tip-bottom absolute top-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-black/55 backdrop-blur-sm transition-all',
            volume != null || pv.open
              ? 'opacity-100 text-gold hover:text-white'
              : 'opacity-0 group-hover:opacity-100 text-white/85 hover:text-gold'
          )}
        >
          <Volume2 size={13} />
        </button>
      )}
      <button
        data-tip={confirmDelete ? 'Click again to delete' : 'Delete preset'}
        aria-label="Delete preset"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          if (!confirmDelete) {
            setConfirmDelete(true)
          } else if (preset.id != null) {
            setConfirmDelete(false)
            void tt.command({ type: 'presetDelete', presetId: preset.id })
          }
        }}
        className={cx(
          'tip-bottom absolute bottom-2 right-2 z-10 flex h-7 items-center justify-center gap-1.5 rounded-md backdrop-blur-sm transition-all',
          confirmDelete
            ? 'px-2.5 bg-alert text-white opacity-100 shadow-lg'
            : cx('w-7 bg-black/55 text-white/85 hover:text-alert', 'opacity-0 group-hover:opacity-100')
        )}
      >
        <Trash2 size={13} />
        {confirmDelete && (
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wide">sure?</span>
        )}
      </button>
      </div>

      <div className="mt-2 px-1">
        <div className={cx('text-[12.5px] leading-snug line-clamp-2', playing ? 'text-gold' : 'text-ink')}>
          {preset.name ?? `Preset ${preset.id}`}
        </div>
        <div className="microlabel mt-1">
          {String(preset.id).padStart(2, '0')}
          {preset.class ? ` · ${preset.class.replace(/^stream\./, '')}` : ''}
        </div>
      </div>
      {pv.popover}
    </div>
  )
}
