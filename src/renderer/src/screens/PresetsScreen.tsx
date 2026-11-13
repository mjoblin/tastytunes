import { useCallback, useEffect, useRef, useState } from "react";
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
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Crosshair, Footprints, Library, Radio, RadioTower } from "lucide-react";
import { isPreAmpMode, type PresetItem } from "@shared/smoip";
import { presetVolumeKey } from "@shared/model";
import { ViewOptions } from "@/components/library/lenses/ViewOptions";
import { tt } from "@/api";
import { useStore } from "@/store";
import { useLitPresets } from "@/hooks/useLitPresets";
import { EmptyActions, EmptyState } from "@/components/chrome/EmptyState";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { flashTarget, scrollToWithContext } from "@/lib/scroll";
import { DND_ACCESSIBILITY } from "@/lib/dnd";
import { gridColumnsOf, ListKeysContext, useListKeys } from "@/hooks/useListKeys";
import { openMenuOn } from "@/lib/menuAt";
import { cx, matchesFilter } from "@/lib/format";
import { FilterInput } from "@/components/controls/FilterInput";
import {
  HeaderChip,
  ScreenTitle,
  GAP_BETWEEN,
  GAP_WITHIN,
  pageEdges,
} from "@/components/chrome/Chrome";
import { TUNING_WINDOW_MS } from "@/hooks/useStationTuning";
import { PresetCard, PresetRow } from "@/components/presets/PresetTiles";

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
  // is asleep or on its way back (clicking a preset in
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
  // except the passage of time: main watches every recall and says when one
  // came to nothing (main/device/recallWatch, 0.15.0: one clock, 8 s after the
  // streamer is awake, still inside the tuning window, TUNING_WINDOW_MS)
  const deadPresets = useStore((s) => s.deadPresets);
  const clearDeadPreset = useStore((s) => s.clearDeadPreset);
  const recall = (presetId: number): void => {
    setTuningId(presetId);
    setWakeRecallId(asleep ? presetId : null);
    clearDeadPreset(presetId);
    if (tuningTimer.current) clearTimeout(tuningTimer.current);
    tuningTimer.current = setTimeout(() => {
      setTuningId(null);
      setWakeRecallId(null);
    }, TUNING_WINDOW_MS);
    // Recalling what is ALREADY playing legitimately changes nothing, so main
    // is told it is lit, and never watches that recall
    void tt
      .command({ type: "recallPreset", presetId, alreadyPlaying: playingIds.has(presetId) })
      .catch(() => {
        setTuningId(null);
        setWakeRecallId(null);
      });
  };
  useEffect(
    () => () => {
      if (tuningTimer.current) clearTimeout(tuningTimer.current);
    },
    [],
  );
  // a recall main says came to nothing stops its tuning lamp
  useEffect(() => {
    if (tuningId != null && deadPresets.includes(tuningId)) setTuningId(null);
  }, [deadPresets, tuningId]);
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
  const isPresetDead = (p: PresetItem): boolean => p.id != null && deadPresets.includes(p.id);
  const noteRepair = (id: number): void => {
    repairAt.current = Date.now();
    repairPlayingId.current = items.find(isPresetPlaying)?.id ?? null;
    clearDeadPreset(id);
  };

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    void tt.command({ type: "presetMove", from: active.id as number, to: over.id as number });
  };

  // FROM THE KEYBOARD (0.14.0): Presets one Tab stop; up and down through the
  // rows, all four in the cards; Enter recalls as a click does, "." the preset's More menu (its
  // repair there too), and Option with up or down moves it, ONE presetMove on Option's release
  // (shown moved until the streamer's new list arrives). Presets aren't removed in the app.
  const [movePreview, setMovePreview] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => setMovePreview(null), [presets]);
  const shownItems = movePreview ? arrayMove(items, movePreview.from, movePreview.to) : items;
  const cardGridRef = useRef<HTMLDivElement | null>(null);
  const keys = useListKeys({
    count: shownItems.length,
    columns: cards ? () => gridColumnsOf(cardGridRef.current) : undefined,
    initial: () => shownItems.findIndex(isPresetPlaying),
    onEnter: (i) => {
      const p = shownItems[i];
      if (p?.id != null) recall(p.id);
    },
    onMenu: (_i, el) => openMenuOn(el),
    move: filter
      ? undefined
      : {
          preview: (from, to) => setMovePreview({ from, to }),
          commit: (from, to) => {
            const a = items[from]?.id;
            const b = items[to]?.id;
            if (a == null || b == null) return setMovePreview(null);
            void tt.command({ type: "presetMove", from: a, to: b });
            // a streamer that never answers doesn't leave the preview standing
            setTimeout(() => setMovePreview(null), 4000);
          },
          cancel: () => setMovePreview(null),
        },
  });

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

  // A REPAIR IS MAINTENANCE, NOT PLAYBACK (repairing a preset
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
            {/* Rows or Cards and the cards' size, gap and Fill rows (0.14.0) */}
            <ViewOptions kind="presets" />
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
        {...keys.container}
        ref={(el) => {
          setContainerRef(el);
          keys.container.ref(el);
        }}
        aria-label="Presets"
        className={cx(
          "flex-1 overflow-y-auto",
          pageEdges(),
          cards ? "px-8" : "px-6 divide-y divide-edge/50",
        )}
      >
        <ListKeysContext.Provider value={true}>
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
                  ref={cardGridRef}
                  className="grid"
                  style={{
                    gridTemplateColumns: presetFillRows
                      ? `repeat(auto-fill, minmax(${presetCardSize}px, 1fr))`
                      : `repeat(auto-fill, ${presetCardSize}px)`,
                    gap: presetGap,
                  }}
                >
                  {shownItems.map((preset, i) => (
                    <PresetCard
                      key={preset.id}
                      listItem={keys.item(i)}
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
                shownItems.map((preset, i) => (
                  <PresetRow
                    key={preset.id}
                    listItem={keys.item(i)}
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
        </ListKeysContext.Provider>
      </div>
    </div>
  );
}
