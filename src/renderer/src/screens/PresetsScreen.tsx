import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  Crosshair,
  Footprints,
  LayoutGrid,
  Library,
  Loader2,
  MoreHorizontal,
  Play,
  Radio,
  RadioTower,
  Rows3,
  Volume2,
} from "lucide-react";
import { isPreAmpMode, type PresetItem } from "@shared/smoip";
import { presetVolumeKey, type ScreenLayout, type MediaNode } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { useLitPresets } from "@/hooks/useLitPresets";
import { Eqbars } from "@/components/media/Eqbars";
import { EmptyActions, EmptyState } from "@/components/chrome/EmptyState";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { flashTarget, scrollToWithContext } from "@/lib/scroll";
import { DND_ACCESSIBILITY, lockVertical } from "@/lib/dnd";
import { CARD_GLYPH_STROKE, MEDIA_ART_FALLBACK } from "@/components/media/MediaArt";
import { OrderHandle } from "@/components/controls/OrderHandle";

/** The same glyph the tray panel's preset tiles fall back to — one table. */
const PresetGlyph = MEDIA_ART_FALLBACK.preset;
import { cx, matchesFilter } from "@/lib/format";
import { FilterInput } from "@/components/controls/FilterInput";
import { Slider } from "@/components/controls/Slider";
import { ArtImage } from "@/components/media/ArtImage";
import { PopoverChrome } from "@/hooks/usePopover";
import { POPOVER_CARD, PopoverCard } from "@/components/chrome/Overlay";
import { HeaderChip, ScreenTitle, GAP_BETWEEN, GAP_WITHIN } from "@/components/chrome/Chrome";
import { ConfirmActions, useConfirmPopover } from "@/components/chrome/Confirm";
import { artSrc } from "@/lib/artSrc";
import { RowMenu } from "@/components/media/RowMenu";
import { openArtistInLibrary, openRefInLibrary } from "@/lib/mediaActions";
import { fromNode } from "@/lib/mediaRef";
import { TUNING_WINDOW_MS } from "@/hooks/useStationTuning";
import { menuAt } from "@/lib/menuAt";

/** A recall that moved nothing after this long is treated as dead — well inside TUNING_WINDOW_MS. */
const DEAD_RECALL_MS = 8_000;

export function PresetsScreen(): React.JSX.Element {
  const presets = useStore((s) => s.presets);
  const saveSettings = useStore((s) => s.saveSettings);
  const zoneState = useStore((s) => s.zoneState);
  const { presetCardSize, presetGap, presetFillRows, followPresets, presetsLayout } = useStore(
    (s) => s.settings,
  );
  const systemInfo = useStore((s) => s.systemInfo);
  const presetVolumes = useStore((s) => s.settings.presetVolumes);
  const presetArtists = useStore((s) => s.settings.presetArtists);
  const cards = presetsLayout === "cards";
  const filter = useStore((s) => s.screenFilters.presets);
  const setScreenFilter = useStore((s) => s.setScreenFilter);
  const setScreen = useStore((s) => s.setScreen);
  const allItems = (presets?.presets ?? []).filter((p) => p.id != null);
  // type/class are hidden fields but filterable: "radio" / "media" work —
  // as is the locally-recorded artist (the wire has no artist field; TT
  // notes it at Library save time), so "iron" finds an Iron Maiden album.
  const items = filter
    ? allItems.filter((p) =>
        matchesFilter(filter, [
          p.name,
          p.type,
          p.class,
          p.id != null ? presetArtists[presetVolumeKey(systemInfo?.udn, p.id)] : null,
        ]),
      )
    : allItems;

  // Feature 10: per-preset volume overrides. Absolute volume needs pre-amp
  // mode — control-bus devices only nudge, so the affordance hides there.
  const canSetVolume = isPreAmpMode(zoneState);
  const volumeFor = (id: number): number | null =>
    presetVolumes[presetVolumeKey(systemInfo?.udn, id)] ?? null;
  const saveVolume = async (id: number, level: number | null): Promise<void> => {
    const key = presetVolumeKey(systemInfo?.udn, id);
    const next = { ...presetVolumes };
    if (level == null) delete next[key];
    else next[key] = level;
    await saveSettings({ presetVolumes: next });
  };
  // Pointer AND keyboard (the playlists pattern): device presets deserve the
  // same reorderability without a mouse as everything else that sorts.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
  // A LIT PRESET MEANS "THIS IS PLAYING" — so nothing lights while the streamer
  // is asleep or on its way back (user report 2026-07-26: clicking a preset in
  // standby scrolled to the PREVIOUSLY-played one first, then to the clicked
  // one). Wake-on-intent holds a play-shaped command for ~3s (ensureAwake:
  // ON → readiness → 2.5s settle) and the waking device re-announces its
  // RETAINED pre-standby play_state, so the old preset's content check passes
  // again mid-wake. Follow reads that as a track change and glides to it —
  // then glides again when the real recall lands. Suppressing the lamp for the
  // whole not-ON window removes the transition rather than racing it, and it's
  // the honest reading besides: the Now Playing screen already shows a sleeping
  // face for exactly this state. `waking` covers the tail, where power reads ON
  // but the zone is still settling.
  const systemPower = useStore((s) => s.systemPower);
  const waking = useStore((s) => s.waking);
  const asleep = (systemPower != null && systemPower.power !== "ON") || waking;
  // ONE preset lights, in this priority:
  //  1. The preset most recently recalled through this app, while a content
  //     check confirms its stuff is still what's playing (the check is the
  //     validity guard — a stale recall goes dark on its own). This is what
  //     disambiguates duplicate saved queues and stops an album preset from
  //     stealing the lamp while its album plays inside a recalled queue.
  //  2. Stateless fallback (startup, recalls made from other controllers):
  //     radio_id is authoritative; a saved queue lights only when it's the
  //     UNIQUE fingerprint match; album art/name matching is suppressed while
  //     the queue is a recognized saved queue (the queue explains the playing
  //     track better than the album does); input-type presets trust the flag
  //     off local media.

  // A recall takes seconds on the device (source switch, stream connect,
  // queue load) with no state change until it lands — mirror the Radio
  // screen's "tuning in" treatment on the recalled tile until the playing
  // lamp takes over, the command fails, or a dead recall times out.
  const [tuningId, setTuningId] = useState<number | null>(null);
  // A recall issued while the streamer sleeps doesn't reach the device for ~3s
  // (ensureAwake: ON → readiness → 2.5s settle), and `waking` ends BEFORE the
  // recall lands — a gap the wake's re-announced pre-standby play_state slots
  // straight into, lighting the PREVIOUSLY-played preset just long enough for
  // follow to start gliding at it. So a recall made from standby claims the
  // lamp: until it lands (or the tuning window lapses), it is the only preset
  // allowed to light. NB tuningId itself can't bound this — it is never
  // cleared on success, only hidden once the tile is playing, and it lingers
  // for the full 15s.
  const [wakeRecallId, setWakeRecallId] = useState<number | null>(null);
  const tuningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A preset whose stored object id the media server no longer resolves is
  // ACCEPTED by the firmware and then silently ignored — no error, no state
  // change (live-probed 2026-07-27). Nothing distinguishes that from "slow"
  // except the passage of time, so watch for a recall that moved nothing.
  // A real recall lands in ~3s; 8s is generous and still inside the tuning
  // window (TUNING_WINDOW_MS, shared with station rows).
  const [deadIds, setDeadIds] = useState<Set<number>>(new Set());
  const deadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackSignature = (): string => {
    const s = useStore.getState();
    return JSON.stringify([
      s.playState?.state,
      s.playState?.queue_id,
      s.playState?.metadata?.title,
      s.queue?.play_id,
      s.queue?.total,
    ]);
  };
  const recall = (presetId: number): void => {
    setTuningId(presetId);
    setWakeRecallId(asleep ? presetId : null);
    setDeadIds((prev) => {
      if (!prev.has(presetId)) return prev;
      const next = new Set(prev);
      next.delete(presetId);
      return next;
    });
    if (tuningTimer.current) clearTimeout(tuningTimer.current);
    tuningTimer.current = setTimeout(() => {
      setTuningId(null);
      setWakeRecallId(null);
    }, TUNING_WINDOW_MS);
    // Recalling what is ALREADY playing legitimately changes nothing — the
    // one false positive this check has, so it never arms in that case.
    const alreadyPlaying = playingIds.has(presetId);
    const before = playbackSignature();
    if (deadTimer.current) clearTimeout(deadTimer.current);
    if (!alreadyPlaying) {
      deadTimer.current = setTimeout(() => {
        if (playbackSignature() !== before) return;
        setDeadIds((prev) => new Set(prev).add(presetId));
        setTuningId((cur) => (cur === presetId ? null : cur));
      }, DEAD_RECALL_MS);
    }
    void tt.command({ type: "recallPreset", presetId }).catch(() => {
      setTuningId(null);
      setWakeRecallId(null);
      if (deadTimer.current) clearTimeout(deadTimer.current);
    });
  };
  useEffect(
    () => () => {
      if (tuningTimer.current) clearTimeout(tuningTimer.current);
      if (deadTimer.current) clearTimeout(deadTimer.current);
    },
    [],
  );
  // The claim can't rest on what this screen knew at CLICK time: for the first
  // seconds after connecting, systemPower is still null here while the main
  // process already knows the streamer is asleep — so the click reads awake,
  // makes no claim, and the wake re-announcement lights the old preset after
  // all. Latch off the authoritative signal instead: main says it is waking,
  // and we know which preset we asked for.
  useEffect(() => {
    if (waking && tuningId != null) setWakeRecallId(tuningId);
  }, [waking, tuningId]);
  // The lit-preset derivation lives in useLitPresets — the tray panel needs
  // the same answer, and a rule this hard-won must not exist in two places.
  const playingIds = useLitPresets(allItems, wakeRecallId);
  const isPresetPlaying = (p: PresetItem): boolean => p.id != null && playingIds.has(p.id);
  const isPresetDead = (p: PresetItem): boolean => p.id != null && deadIds.has(p.id);
  const noteRepair = (id: number): void => {
    repairAt.current = Date.now();
    repairPlayingId.current = items.find(isPresetPlaying)?.id ?? null;
    clearDead(id);
  };
  const clearDead = (id: number): void =>
    setDeadIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    void tt.command({ type: "presetMove", from: active.id as number, to: over.id as number });
  };

  // Scroll container: combine scroll memory (skipped when following) with a
  // queryable ref for scroll-to-playing.
  const scrollMemory = useScrollMemory("presets", !followPresets);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      scrollMemory(node);
    },
    [scrollMemory],
  );
  // Cards get half a card of context above the target; rows get a full row.
  const scrollToPlaying = useCallback(
    (flash = false, behavior?: ScrollBehavior): void => {
      const el = containerRef.current?.querySelector('[data-playing="true"]') as HTMLElement | null;
      scrollToWithContext(el, cards ? presetGap : 8, cards ? 0.5 : 1, behavior);
      if (flash) flashTarget(el);
    },
    [presetGap, cards],
  );

  // A REPAIR IS MAINTENANCE, NOT PLAYBACK (user, 2026-07-27: repairing a preset
  // scrolled the list to the last-played one). Writing a slot makes the device
  // re-push /presets/list — measured ~4.3s later on the Evo, where the mock
  // broadcasts instantly — and the follow effect must not treat anything that
  // push stirs up as a track change. The window is generous enough to cover
  // that lag, and the guard only holds while the PLAYING preset is unchanged,
  // so starting something else during it still follows normally.
  const repairAt = useRef(0);
  const repairPlayingId = useRef<number | null>(null);
  const playingId = items.find(isPresetPlaying)?.id ?? null;
  // First follow after mount positions INSTANTLY — re-entering the screen
  // shouldn't replay a glide to a place you already were. The animation is
  // reserved for track changes while you're watching.
  const firstFollow = useRef(true);
  useEffect(() => {
    const settlingRepair =
      Date.now() - repairAt.current < 8000 && playingId === repairPlayingId.current;
    // Follow pauses while a filter is active — the playing card may be hidden.
    if (followPresets && playingId != null && !filter && !settlingRepair) {
      scrollToPlaying(false, firstFollow.current ? "auto" : undefined);
    }
    firstFollow.current = false;
  }, [followPresets, playingId, scrollToPlaying, filter]);

  const setFollowPresets = async (follow: boolean): Promise<void> => {
    await saveSettings({ followPresets: follow });
  };
  const setLayout = async (presetsLayout: ScreenLayout): Promise<void> => {
    await saveSettings({ presetsLayout });
  };

  if (allItems.length === 0) {
    return (
      <EmptyState
        className="h-full"
        icon={Radio}
        title="No presets"
        caption="Save radio stations or albums to a preset slot from their menus anywhere in the app and they'll appear here for one-click recall."
      >
        <EmptyActions
          actions={[
            { label: "Library", icon: Library, keyHint: "I", onClick: () => setScreen("library") },
            { label: "Radio", icon: RadioTower, keyHint: "R", onClick: () => setScreen("radio") },
          ]}
        />
      </EmptyState>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <ScreenTitle>Presets</ScreenTitle>
        <span className="font-mono text-[11px] text-faint">
          {allItems.length} / {presets?.max_presets ?? "—"} slots
        </span>
        <div className="flex-1" />
        <div className={`flex items-center ${GAP_BETWEEN}`}>
          <FilterInput
            value={filter}
            onChange={(t) => setScreenFilter("presets", t)}
            shown={items.length}
            total={allItems.length}
          />
          <div className={`flex items-center ${GAP_WITHIN}`}>
            <HeaderChip
              data-tip={cards ? "View as rows" : "View as cards"}
              aria-label={cards ? "View as rows" : "View as cards"}
              onClick={() => void setLayout(cards ? "rows" : "cards")}
              className="no-drag tip-bottom p-2 motion-safe:active:scale-90"
            >
              {cards ? <Rows3 size={16} /> : <LayoutGrid size={16} />}
            </HeaderChip>
            <HeaderChip
              data-tip="Scroll to the playing preset"
              aria-label="Scroll to the playing preset"
              onClick={() => scrollToPlaying(true)}
              className="no-drag tip-bottom p-2 motion-safe:active:scale-90"
            >
              <Crosshair size={16} />
            </HeaderChip>
            <HeaderChip
              active={followPresets}
              data-tip={followPresets ? "Auto-follow: on" : "Auto-follow: off"}
              aria-label={followPresets ? "Auto-follow: on" : "Auto-follow: off"}
              onClick={() => void setFollowPresets(!followPresets)}
              className="no-drag tip-bottom p-2"
            >
              <Footprints size={16} />
            </HeaderChip>
          </div>
        </div>
      </header>

      {/* rows: pt-1 keeps the playing ring unclipped; cards: pt-2 gives the
          hover grow + glow ring headroom on the top row */}
      <div
        ref={setContainerRef}
        className={cx(
          "flex-1 overflow-y-auto",
          cards ? "px-8 pb-8 pt-2" : "px-6 pb-6 pt-1 divide-y divide-edge/50",
        )}
      >
        {items.length === 0 && (
          <div className="text-[15px] text-faint pt-6 px-2">No matches for “{filter}”</div>
        )}
        {/* Reordering a partial list is ambiguous — drags are inert while filtered. */}
        <DndContext
          accessibility={DND_ACCESSIBILITY}
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
                  gap: presetGap,
                }}
              >
                {items.map((preset) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    playing={isPresetPlaying(preset)}
                    dead={isPresetDead(preset)}
                    onRepaired={() => preset.id != null && noteRepair(preset.id)}
                    tuning={tuningId === preset.id && !isPresetPlaying(preset)}
                    onRecall={() => preset.id != null && recall(preset.id)}
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
                  dead={isPresetDead(preset)}
                  onRepaired={() => preset.id != null && noteRepair(preset.id)}
                  tuning={tuningId === preset.id && !isPresetPlaying(preset)}
                  onRecall={() => preset.id != null && recall(preset.id)}
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
  );
}

interface PresetVolumeProps {
  /** Saved override, or null. */
  volume: number | null;
  /** Pre-amp mode only — control-bus devices can't set an absolute level. */
  canSetVolume: boolean;
  onVolume(level: number | null): void;
}

/**
 * Feature 10's popover, shared by rows and cards: the app's anchored popover (PopoverCard), so it
 * opens where it was asked for, under the gold speaker or where the ⋯ menu stood, and is clamped
 * on screen (it opened right-aligned and upward before 0.12.0, landing over the next card). Saving
 * is EXPLICIT: the slider only stages a draft and the gold Set button commits, so clicking away
 * always means "never mind".
 */
function usePresetVolumePopover(
  volume: number | null,
  onVolume: (level: number | null) => void,
): {
  open: boolean;
  /** Opens under an element (the gold speaker). */
  openFrom(e: { currentTarget: Element; stopPropagation(): void }): void;
  /** Opens at a point (where the ⋯ menu that offered "Preset volume…" stood). */
  openAt(at: { x: number; y: number }): void;
  popover: React.ReactNode;
} {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const zoneVolume = useStore((s) => s.zoneState?.volume_percent);
  const open = at != null;

  const level = draft ?? volume ?? zoneVolume ?? 25;

  const openAt = (point: { x: number; y: number }): void => {
    setDraft(null);
    setAt(point);
  };
  const openFrom = (e: { currentTarget: Element; stopPropagation(): void }): void => {
    e.stopPropagation();
    if (open) {
      setAt(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    openAt({ x: r.left, y: r.bottom + 6 });
  };

  const popover = at && (
    // the card or row underneath recalls on click: the popover's clicks (and its click-away)
    // stop here, never reaching it through React's tree
    <PopoverStop>
      <PopoverCard
        at={at}
        width="w-60"
        onClose={() => setAt(null)}
        className="p-3"
        data-preset-volume-popover
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
          TastyTunes sets this volume whenever it starts this preset. Recalls from the official app
          or the streamer itself aren't affected.
        </span>
        {/* the app's action row (Confirm): Cancel and Set right-aligned; Clear, which removes
            the preset's volume rather than setting one, apart on the left */}
        <ConfirmActions
          tone="gold"
          verb={`Set ${level}%`}
          onCancel={() => setAt(null)}
          onConfirm={() => {
            onVolume(level);
            setAt(null);
          }}
          start={
            volume != null && (
              <button
                onClick={() => {
                  onVolume(null);
                  setAt(null);
                }}
                className="px-2.5 py-1 rounded-lg text-[12px] ring-1 ring-edge bg-panel/70 text-dim hover:text-alert hover:ring-edge2 hover:bg-raised/70 transition-colors"
              >
                Clear
              </button>
            )
          }
        />
      </PopoverCard>
    </PopoverStop>
  );

  return { open, openFrom, openAt, popover };
}

/** Holds a popover's clicks: a preset's row recalls on click, and React carries a portal's events
 *  up its component tree, so a click inside a popover (or on its click-away backdrop) would
 *  otherwise recall the preset underneath; pointer-downs would start a card's drag, a right-click
 *  would reopen the menu. */
function PopoverStop({ children }: { children: React.ReactNode }): React.JSX.Element {
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation();
  return (
    <span className="contents" onClick={stop} onPointerDown={stop} onContextMenu={stop}>
      {children}
    </span>
  );
}

/**
 * THE ARTWORK IS THE FINGERPRINT: a media preset's album in the library is the one album whose
 * art URL is the preset's (the streamer keeps no object id worth trusting, Asset re-mints them
 * on a rescan, but the art id survives; 44/44 of the author's UPnP presets matched this way).
 * One home: the repair chip finds the album's current id with it, the ⋯ menu's Open in Library
 * and Go to artist find the album. Null when no album, or more than one, carries the art.
 */
async function presetAlbum(preset: PresetItem): Promise<MediaNode | null> {
  if (!preset.art_url) return null;
  const pools = await tt.mediaIndexPools();
  const hits = pools.flatMap((pool) =>
    pool.albums.filter((a) => a.artUrl != null && a.artUrl === preset.art_url),
  );
  return hits.length === 1 ? hits[0] : null;
}

/**
 * A PRESET'S ⋯ (0.12.0, his call after a user's email asked why a preset plays rather than
 * opening): a click still recalls (a preset is the streamer's button, and the streamer keeps no
 * track list for it), and the ⋯, where the trash used to be, holds the rest. Play; Open in
 * Library and Go to artist for a media preset (by its art, presetAlbum; a station or a saved
 * queue has nothing to open); Rename… in place; Preset volume…; Delete preset, last and
 * confirmed, only here. Right-click opens it too.
 */
function usePresetMenu(
  preset: PresetItem,
  d: {
    onRecall(): void;
    pv: ReturnType<typeof usePresetVolumePopover>;
    canVolume: boolean;
    startRename(): void;
  },
): {
  open(e: React.MouseEvent): void;
  isOpen: boolean;
  popovers: React.ReactNode;
} {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const confirmDelete = useConfirmPopover();
  const showToast = useStore((s) => s.showToast);
  const name = preset.name ?? `Preset ${preset.id}`;
  // what the menu offers opens where the menu stood (the ⋯ clicked, or the right-click's point),
  // so a choice turns into its popover in place
  const [from, setFrom] = useState<{ x: number; y: number } | null>(null);
  const here = (): { x: number; y: number } => from ?? { x: 0, y: 0 };
  // A MEDIA PRESET by its class: the Evo calls a library album's preset type "UPnP" (read
  // 2026-10-17; the mock had "MEDIA"), a station "Radio", an input "Input", and a saved queue is a
  // "MediaQueue" with a collage of covers, nothing to open
  const media =
    /^stream\.media/.test(preset.class ?? "") &&
    preset.type !== "MediaQueue" &&
    !(preset.art_urls && preset.art_urls.length > 1);
  const withAlbum = (then: (album: MediaNode) => void): void => {
    void presetAlbum(preset).then((album) => {
      if (album) then(album);
      else showToast({ kind: "error", text: `Couldn't find “${name}” in your library.` });
    });
  };
  const items = [
    { label: "Play", run: d.onRecall },
    ...(media
      ? [
          {
            label: "Open in Library",
            run: () => withAlbum((a) => void openRefInLibrary(fromNode(a, a.serverUdn))),
          },
          {
            label: "Go to artist",
            run: () =>
              withAlbum((a) => {
                if (a.artist) openArtistInLibrary(a.artist);
                else showToast({ kind: "error", text: `“${name}” has no artist in your library.` });
              }),
          },
        ]
      : []),
    { label: "Rename…", run: d.startRename },
    ...(d.canVolume ? [{ label: "Preset volume…", run: () => d.pv.openAt(here()) }] : []),
    {
      label: "Delete preset",
      run: () =>
        confirmDelete.askAt(here(), {
          question: `Delete “${name}”?`,
          onConfirm: () => {
            if (preset.id != null) void tt.command({ type: "presetDelete", presetId: preset.id });
          },
        }),
    },
  ];
  return {
    open: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setAt(menuAt(e));
      setFrom(menuAt(e));
    },
    isOpen: at != null,
    // rendered only while something is open: a row's grid counts its children (S2's anatomy)
    popovers:
      at || confirmDelete.popover ? (
        <PopoverStop>
          {at && <RowMenu title={name} at={at} items={items} onClose={() => setAt(null)} />}
          {confirmDelete.popover}
        </PopoverStop>
      ) : null,
  };
}

/** A preset's name, edited in place: Enter or leaving the field saves it (trimmed, if changed),
 *  Escape keeps the old one. The streamer's own rename verb, until now only offered at save. */
function PresetNameEdit({
  preset,
  className,
  onDone,
}: {
  preset: PresetItem;
  className: string;
  onDone(): void;
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean): void => {
    if (done.current) return;
    done.current = true;
    const name = ref.current?.value.trim() ?? "";
    if (save && name && name !== preset.name && preset.id != null)
      void tt.command({ type: "presetRename", slot: preset.id, name });
    onDone();
  };
  return (
    <input
      ref={ref}
      data-preset-rename
      defaultValue={preset.name ?? ""}
      aria-label={`Rename preset ${preset.id}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      className={cx(
        "w-full min-w-0 rounded-md bg-panel ring-1 ring-edge2 px-1.5 py-0.5 outline-none focus:ring-gold/60",
        className,
      )}
    />
  );
}

/** Row view of a preset — mirrors the queue row's anatomy. */
function PresetRow({
  preset,
  playing,
  dead,
  onRepaired,
  tuning,
  onRecall,
  volume,
  canSetVolume,
  onVolume,
}: {
  preset: PresetItem;
  playing: boolean;
  /** Recall was accepted and then silently ignored — see RepairChip. */
  dead?: boolean;
  onRepaired?(): void;
  tuning: boolean;
  onRecall(): void;
} & PresetVolumeProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: preset.id as number,
  });
  const pv = usePresetVolumePopover(volume, onVolume);
  const [renaming, setRenaming] = useState(false);
  const menu = usePresetMenu(preset, {
    onRecall,
    pv,
    canVolume: canSetVolume || volume != null,
    startRename: () => setRenaming(true),
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(lockVertical(transform)), transition }}
      onContextMenu={menu.open}
      data-playing={playing || undefined}
      className={cx(
        // FIVE columns for five children — the sixth column outlived the
        // trailing grip when it moved into the position cell (OrderHandle),
        // and an empty grid track still costs its gap.
        "group grid grid-cols-[26px_44px_1fr_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5",
        "cursor-default transition-colors",
        isDragging && "z-10 bg-raised shadow-xl",
        // hold the hover highlight while this row's volume popover is open —
        // the pointer leaves the row, but the row is still what's being edited
        playing ? "row-playing bg-gold/10" : pv.open || menu.isOpen ? "bg-veil" : "hover:bg-veil",
      )}
      onClick={renaming ? undefined : onRecall}
    >
      <OrderHandle
        label={`Reorder preset ${preset.id}`}
        attributes={attributes}
        listeners={listeners}
      >
        {playing ? (
          <Eqbars />
        ) : tuning ? (
          <Loader2 data-preset-tuning size={13} className="spin text-gold/80" />
        ) : (
          <span className="font-mono text-[10.5px] text-faint tabular-nums">
            {String(preset.id).padStart(2, "0")}
          </span>
        )}
      </OrderHandle>

      <div className="h-10 w-10 rounded overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
        <ArtImage
          src={artSrc(preset.art_url, 40)}
          lazy
          fallback={<PresetGlyph size={16} className="text-faint" />}
        />
      </div>

      <div className="min-w-0">
        {renaming ? (
          <PresetNameEdit
            preset={preset}
            className="text-[13.5px] text-ink"
            onDone={() => setRenaming(false)}
          />
        ) : (
          <div className={cx("text-[13.5px] truncate", playing ? "text-gold" : "text-ink")}>
            {preset.name ?? `Preset ${preset.id}`}
          </div>
        )}
        <div className="text-[12px] text-dim truncate">
          {preset.class ? preset.class.replace(/^stream\./, "") : ""}
        </div>
      </div>

      <span className="inline-flex items-center" onPointerDown={(e) => e.stopPropagation()}>
        {dead && <RepairChip preset={preset} variant="row" onRepaired={() => onRepaired?.()} />}
        {/* a set volume shows as its status (it changes what a recall does); setting one is the
            ⋯ menu's Preset volume… (0.12.0: the hover speaker went with the menu's arrival) */}
        {volume != null && (
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
        )}
        {pv.popover}
      </span>

      <button
        aria-label="More actions"
        data-preset-menu
        onPointerDown={(e) => e.stopPropagation()}
        onClick={menu.open}
        className={cx(
          "p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all",
          menu.isOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-kbd:opacity-100",
        )}
      >
        <MoreHorizontal size={14} />
      </button>
      {menu.popovers}
    </div>
  );
}

function PresetCard({
  preset,
  playing,
  dead,
  onRepaired,
  tuning,
  onRecall,
  volume,
  canSetVolume,
  onVolume,
}: {
  preset: PresetItem;
  playing: boolean;
  /** Recall was accepted and then silently ignored — see RepairChip. */
  dead?: boolean;
  onRepaired?(): void;
  tuning: boolean;
  onRecall(): void;
} & PresetVolumeProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: preset.id as number,
  });
  const pv = usePresetVolumePopover(volume, onVolume);
  const [renaming, setRenaming] = useState(false);
  const menu = usePresetMenu(preset, {
    onRecall,
    pv,
    canVolume: canSetVolume || volume != null,
    startRename: () => setRenaming(true),
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onContextMenu={menu.open}
      data-playing={playing || undefined}
      className={cx(
        // Inset tile: the gold highlight wraps the gray tile, never the art, so
        // it stays legible on gold/orange album covers.
        // Hover: a slight grow + lift (scale is layout-free, so edge-clipped
        // cards just clip at the scrollport; z-10 keeps the grown card on top).
        "group relative text-left rounded-2xl p-2 pb-2.5 transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]",
        isDragging && "z-10 opacity-90",
        playing ? "bg-goldtile/70 tile-playing" : "bg-raised/50 ring-1 ring-edge card-hover-glow",
        // held while this card's volume popover is open — the pointer has left,
        // but the card is still what's being edited
        (pv.open || menu.isOpen) && "ring-1 ring-edge2",
      )}
    >
      {/* relative wrapper bounds exactly the art, so the corner chips anchor
          to the artwork: playing top-left, a set volume's speaker top-right, the ⋯
          bottom-right (the card grammar's corner) */}
      <div className="relative">
        <button className="relative block w-full cursor-pointer" onClick={onRecall}>
          {/* the art well is a veil lift, never a panel hole — see LibraryCards */}
          <div className="aspect-square w-full rounded-lg overflow-hidden bg-veil flex items-center justify-center">
            {preset.art_urls && preset.art_urls.length > 1 ? (
              // saved-queue (MediaQueue) presets: collage of the queue's albums
              <div
                className={cx(
                  "grid w-full h-full grid-cols-2",
                  preset.art_urls.length > 2 ? "grid-rows-2" : "grid-rows-1",
                )}
              >
                {preset.art_urls.slice(0, 4).map((u) => (
                  <ArtImage
                    key={u}
                    src={artSrc(u, 120)}
                    lazy
                    fallback={<div className="bg-veil h-full w-full" />}
                  />
                ))}
              </div>
            ) : (
              <ArtImage
                src={artSrc(preset.art_url, 240)}
                lazy
                fallback={
                  <PresetGlyph size={34} strokeWidth={CARD_GLYPH_STROKE} className="text-faint" />
                }
              />
            )}

            {/* hover overlay — the whole card recalls the preset; the chip is the affordance */}
            <div className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 group-kbd:opacity-100 transition-opacity flex items-center justify-center">
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
              <span className="absolute top-2 left-2 flex h-7 w-7 items-center justify-center rounded-lg bg-panel/80 ring-1 ring-edge">
                <Eqbars />
              </span>
            )}
            {tuning && (
              // same corner the playing chip will claim — spinner hands over to bars
              <span
                data-preset-tuning
                className="absolute top-2 left-2 flex h-7 w-7 items-center justify-center rounded-lg bg-panel/80 ring-1 ring-edge"
              >
                <Loader2 size={13} className="spin text-gold/90" />
              </span>
            )}
          </div>
        </button>

        {/* the alert takes the corner the tuning spinner hands over, and is a
          sibling of the recall button (not a child) — nested buttons are
          invalid, and this one must not also fire the recall */}
        {dead && <RepairChip preset={preset} variant="card" onRepaired={() => onRepaired?.()} />}

        {/* the gold speaker shows a set volume (presence and color are the status, the tooltip
          carries the percentage, a click adjusts it); setting one is the ⋯ menu's Preset
          volume… (0.12.0: the hover-revealed speaker went with the menu's arrival) */}
        {volume != null && (
          <button
            data-tip={`Recalled at ${volume}% volume`}
            aria-label="Preset volume"
            onClick={pv.openFrom}
            onPointerDown={(e) => e.stopPropagation()}
            data-preset-volume
            className="tip-bottom absolute top-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-lg bg-panel/80 ring-1 ring-edge text-gold hover:text-ink transition-all"
          >
            <Volume2 size={13} />
          </button>
        )}
        <button
          aria-label="More actions"
          data-preset-menu
          onPointerDown={(e) => e.stopPropagation()}
          onClick={menu.open}
          className={cx(
            "absolute bottom-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-lg transition-all",
            "bg-panel/80 ring-1 ring-edge text-dim hover:text-ink",
            menu.isOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-kbd:opacity-100",
          )}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>

      {/* the label is part of the card — clicking it recalls too (it used to
          be a dead zone below the artwork button, which read as a broken card) */}
      <div className="mt-2 px-1 cursor-pointer" onClick={renaming ? undefined : onRecall}>
        {renaming ? (
          <PresetNameEdit
            preset={preset}
            className="text-[12.5px] leading-snug text-ink"
            onDone={() => setRenaming(false)}
          />
        ) : (
          <div
            className={cx(
              "text-[12.5px] leading-snug line-clamp-2",
              playing ? "text-gold" : "text-ink",
            )}
          >
            {preset.name ?? `Preset ${preset.id}`}
          </div>
        )}
        <div className="microlabel mt-1">
          {String(preset.id).padStart(2, "0")}
          {preset.class ? ` · ${preset.class.replace(/^stream\./, "")}` : ""}
        </div>
      </div>
      {pv.popover}
      {menu.popovers}
    </div>
  );
}

/**
 * A preset that points at content its media server no longer resolves. The
 * firmware accepts the recall and silently ignores it, so the app has to name
 * the failure — and can usually fix it: Asset re-mints object ids on a
 * rescan, but the ART id survives, which makes the artwork a reliable
 * fingerprint for finding the same album's CURRENT id in the media index
 * (44/44 of the author's UPnP presets matched this way).
 *
 * Radio presets are out of scope: an airable id has no index to match against.
 */
function RepairChip({
  preset,
  variant,
  onRepaired,
}: {
  preset: PresetItem;
  variant: "card" | "row";
  onRepaired(): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [match, setMatch] = useState<MediaNode | null | undefined>(undefined); // undefined = looking
  const [saving, setSaving] = useState(false);
  const WIDTH = 268;

  const openFrom = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    if (open) return setOpen(false);
    const r = e.currentTarget.getBoundingClientRect();
    setAnchor({
      left: Math.min(Math.max(8, r.left), window.innerWidth - WIDTH - 8),
      top: Math.min(r.bottom + 8, window.innerHeight - 200),
    });
    setMatch(undefined);
    setOpen(true);
    // the artwork is the fingerprint: same art url, same album, current id (presetAlbum)
    setMatch(await presetAlbum(preset));
  };

  const repair = async (): Promise<void> => {
    if (!match?.serverUdn || preset.id == null) return;
    setSaving(true);
    try {
      await tt.mediaPresetSave(match.serverUdn, match.id, preset.id);
      setOpen(false);
      onRepaired();
    } finally {
      setSaving(false);
    }
  };

  const chip =
    variant === "card" ? (
      <button
        data-preset-dead
        data-tip="Didn't load. Click to repair."
        aria-label="Repair preset (didn't load)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => void openFrom(e)}
        className="tip-bottom absolute top-2 left-2 z-10 flex h-7 w-7 items-center justify-center rounded-lg bg-panel/80 ring-1 ring-alert/50 text-alert"
      >
        <AlertTriangle size={13} />
      </button>
    ) : (
      <button
        data-preset-dead
        data-tip="Didn't load. Click to repair."
        aria-label="Repair preset (didn't load)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => void openFrom(e)}
        className="tip-bottom p-1 rounded text-alert hover:text-ink transition-colors"
      >
        <AlertTriangle size={13} />
      </button>
    );

  return (
    <>
      {chip}
      {open &&
        anchor &&
        createPortal(
          <>
            <PopoverChrome onClose={() => setOpen(false)} />
            <span
              className="fixed inset-0 z-30 cursor-default"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
            />
            <span
              data-preset-repair-popover
              style={anchor}
              className={cx("fixed z-40 w-[268px] p-3 block cursor-default", POPOVER_CARD)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className="microlabel text-dim block mb-2">preset didn't load</span>
              <span className="block text-[11px] text-faint leading-relaxed">
                This preset points at something the media server no longer has. Its id changed, most
                likely when the library was rescanned. The streamer accepts the recall and then does
                nothing.
              </span>
              {match === undefined && (
                <span className="block text-[11px] text-faint mt-2.5">Looking in the index…</span>
              )}
              {match === null && (
                <span className="block text-[11px] text-faint mt-2.5">
                  No match in the library index for this preset's artwork, so there's nothing safe
                  to save. Re-save it by hand from the Library.
                </span>
              )}
              {match != null && (
                <>
                  <span className="block text-[12px] text-ink mt-2.5 truncate">{match.title}</span>
                  <span className="block text-[11px] text-dim truncate">
                    {[match.artist, match.serverName].filter(Boolean).join(" · ")}
                  </span>
                  <ConfirmActions
                    tone="gold"
                    busy={saving}
                    verb={saving ? "Repairing…" : `Save to slot ${preset.id}`}
                    onCancel={() => setOpen(false)}
                    onConfirm={() => void repair()}
                  />
                </>
              )}
            </span>
          </>,
          document.body,
        )}
    </>
  );
}
