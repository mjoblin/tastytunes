import { useCallback, useEffect, useRef, useState } from 'react'
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
  Trash2
} from 'lucide-react'
import type { PresetItem } from '@shared/smoip'
import type { ScreenLayout } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { flashTarget, scrollToWithContext } from '@/lib/scroll'
import { cx } from '@/lib/format'

export function PresetsScreen(): React.JSX.Element {
  const presets = useStore((s) => s.presets)
  const playState = useStore((s) => s.playState)
  const zoneState = useStore((s) => s.zoneState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const { presetCardSize, presetGap, presetFillRows, followPresets, presetsLayout } = useStore(
    (s) => s.settings
  )
  const setSettings = useStore((s) => s.setSettings)
  const cards = presetsLayout === 'cards'
  const items = (presets?.presets ?? []).filter((p) => p.id != null)
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
    (flash = false): void => {
      const el = containerRef.current?.querySelector('[data-playing="true"]') as HTMLElement | null
      scrollToWithContext(el, cards ? presetGap : 8, cards ? 0.5 : 1)
      if (flash) flashTarget(el)
    },
    [presetGap, cards]
  )

  const playingId = items.find(isPresetPlaying)?.id ?? null
  useEffect(() => {
    if (followPresets && playingId != null) scrollToPlaying()
  }, [followPresets, playingId, scrollToPlaying])

  const setFollowPresets = async (follow: boolean): Promise<void> => {
    setSettings(await tt.setSettings({ followPresets: follow }))
  }
  const setLayout = async (presetsLayout: ScreenLayout): Promise<void> => {
    setSettings(await tt.setSettings({ presetsLayout }))
  }

  if (items.length === 0) {
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
          {items.length} / {presets?.max_presets ?? '—'} slots
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <button
            data-tip={cards ? 'View as rows' : 'View as cards'}
            aria-label={cards ? 'View as rows' : 'View as cards'}
            onClick={() => void setLayout(cards ? 'rows' : 'cards')}
            className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 active:scale-90 transition-all"
          >
            {cards ? <Rows3 size={16} /> : <LayoutGrid size={16} />}
          </button>
          <button
            data-tip="Scroll to the playing preset"
            aria-label="Scroll to the playing preset"
            onClick={() => scrollToPlaying(true)}
            className="no-drag tip-bottom p-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 active:scale-90 transition-all"
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
      <div ref={setContainerRef} className={cx('flex-1 overflow-y-auto', cards ? 'px-8 pb-8 pt-2' : 'px-6 pb-6 pt-1')}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
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
                  <PresetCard key={preset.id} preset={preset} playing={isPresetPlaying(preset)} />
                ))}
              </div>
            ) : (
              items.map((preset) => (
                <PresetRow key={preset.id} preset={preset} playing={isPresetPlaying(preset)} />
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

/** Row view of a preset — mirrors the queue row's anatomy. */
function PresetRow({ preset, playing }: { preset: PresetItem; playing: boolean }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: preset.id as number
  })
  const [confirmDelete, setConfirmDelete] = useState(false)

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
        'group grid grid-cols-[26px_44px_1fr_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5',
        'cursor-default transition-colors',
        isDragging && 'z-10 bg-raised shadow-xl',
        playing ? 'row-playing bg-gold/10' : 'hover:bg-veil'
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
        {preset.art_url ? (
          <img src={preset.art_url} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <Radio size={16} className="text-faint" />
        )}
      </div>

      <div className="min-w-0">
        <div className={cx('text-[13.5px] truncate', playing ? 'text-gold' : 'text-ink')}>
          {preset.name ?? `Preset ${preset.id}`}
        </div>
        <div className="text-[12px] text-dim truncate">
          {preset.class ? preset.class.replace(/^stream\./, '') : ''}
        </div>
      </div>

      <button
        title={confirmDelete ? 'Click again to delete' : 'Delete preset'}
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
          'flex items-center gap-1 p-1.5 rounded transition-all',
          confirmDelete
            ? 'text-alert opacity-100 bg-alert/15'
            : 'text-faint opacity-0 group-hover:opacity-100 hover:text-alert'
        )}
      >
        <Trash2 size={13} />
        {confirmDelete && <span className="font-mono text-[9px] uppercase tracking-wide">sure?</span>}
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

function PresetCard({ preset, playing }: { preset: PresetItem; playing: boolean }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: preset.id as number
  })
  const [confirmDelete, setConfirmDelete] = useState(false)

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
        'group text-left rounded-2xl p-2 pb-2.5 transition-all duration-300 ease-out hover:z-10 hover:scale-[1.04]',
        isDragging && 'z-10 opacity-90',
        playing ? 'bg-goldtile/70 tile-playing' : 'bg-raised/70 ring-1 ring-edge card-hover-glow'
      )}
    >
      <button
        className="relative block w-full cursor-pointer"
        onClick={() => {
          if (preset.id != null) void tt.command({ type: 'recallPreset', presetId: preset.id })
        }}
      >
        <div className="aspect-square w-full rounded-lg overflow-hidden bg-panel/70 flex items-center justify-center">
          {preset.art_url ? (
            <img src={preset.art_url} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <Radio size={34} strokeWidth={1.2} className="text-faint" />
          )}

          {/* hover overlay — the whole card recalls the preset; the chip is the affordance */}
          <div className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <span
              className="h-11 w-11 rounded-full bg-amber text-bg flex items-center justify-center
                         transition-all duration-150 hover:scale-110
                         hover:shadow-[0_0_24px_rgb(var(--amber-rgb)_/_0.6)]"
            >
              <Play size={18} fill="currentColor" strokeWidth={0} className="translate-x-[1px]" />
            </span>
          </div>

          {playing && (
            <span className="absolute top-2 left-2 flex items-center rounded-md bg-black/55 backdrop-blur-sm px-1.5 py-1">
              <span className="eqbars text-gold">
                <span style={{ height: 6 }} />
                <span style={{ height: 10 }} />
                <span style={{ height: 5 }} />
              </span>
            </span>
          )}
        </div>
      </button>

      <div className="mt-2 px-1 flex items-start gap-1">
        <div className="flex-1 min-w-0">
          <div className={cx('text-[12.5px] leading-snug line-clamp-2', playing ? 'text-gold' : 'text-ink')}>
            {preset.name ?? `Preset ${preset.id}`}
          </div>
          <div className="microlabel mt-1">
            {String(preset.id).padStart(2, '0')}
            {preset.class ? ` · ${preset.class.replace(/^stream\./, '')}` : ''}
          </div>
        </div>
        <button
          title={confirmDelete ? 'Click again to delete' : 'Delete preset'}
          onPointerDown={(e) => e.stopPropagation() /* keep dnd-kit's drag sensor out of it */}
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
            'flex items-center gap-1 p-1 rounded transition-all',
            confirmDelete
              ? 'text-alert opacity-100 bg-alert/15'
              : 'text-faint opacity-0 group-hover:opacity-100 hover:text-alert'
          )}
        >
          <Trash2 size={13} />
          {confirmDelete && <span className="font-mono text-[9px] uppercase tracking-wide">sure?</span>}
        </button>
      </div>
    </div>
  )
}
