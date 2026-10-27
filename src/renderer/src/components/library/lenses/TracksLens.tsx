import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Play } from "lucide-react";
import {
  audioAnalysisKey,
  type AppSettings,
  type MediaIndexPools,
  type MediaNode,
  nameSortKey,
  trackPosition,
} from "@shared/model";
import { cx, matchesFilter, fmtCount, fmtAgo, fmtTime } from "@/lib/format";
import { usePlayStats } from "@/lib/playStats";
import { playedBucket, playedOptionsOf, talliesOf } from "@/lib/playStatsView";
import { useStore } from "@/store";
import { FACT_SEP } from "@/lib/mediaFacts";
import { useKnownStats, USB_ANALYSIS_HINT } from "@/lib/audioAnalysis";
import { useWindowedList } from "@/hooks/useWindowedList";
import { fmtLufs } from "@/components/media/Waveform";
import { FilterInput } from "@/components/controls/FilterInput";
import { PrimaryButton, GAP_BETWEEN, GAP_WITHIN } from "@/components/chrome/Chrome";
import { SortChip } from "@/components/controls/SortChip";
import { ViewOptions } from "./ViewOptions";
import { useTrackCardDetails } from "@/components/library/useCardDetails";
import { PickerPill } from "@/components/controls/PickerPill";
import { TrackRow } from "@/components/library/LibraryCards";
import { RowMenu } from "@/components/media/RowMenu";
import {
  type LensActions,
  lc,
  nodeKey,
  drOptionsOf,
  tempoBandLabel,
  tempoBandOf,
  tempoOptionsOf,
  formatTags,
  formatOptionsOf,
  decadeOf,
  RECORD_SORTS,
  PLAY_THESE_MAX,
  filterFields,
  filterScopeCounts,
  type FilterScope,
} from "./lensShared";
import {
  useLensTrackSelection,
  LensTrackSelectionBar,
  LensTrackMenu,
} from "./useLensTrackSelection";
import { useLensIndex } from "./useLensIndex";
import { TrackCards } from "./TrackCards";
import { menuAt } from "@/lib/menuAt";

// The Tracks lens, split out of LibraryLenses.tsx (2026-09-13, the lenses round: three lenses of
// 600 to 800 lines shared one file); what the lenses share lives in ./lensShared.

/** The filter's "search in" choices, in the menu's order, after All fields. */
const SCOPES: FilterScope[] = ["title", "artist", "album"];
const SCOPE_LABEL: Record<FilterScope, string> = {
  title: "Title",
  artist: "Artist",
  album: "Album",
};

const TRACK_SORTS: Array<{
  value: AppSettings["lensTracksSort"];
  label: string;
}> = [
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "album", label: "Album" },
  { value: "year", label: "Year (newest first)" },
  { value: "duration", label: "Duration (longest first)" },
  { value: "dr", label: "Dynamic range" },
  { value: "loudness", label: "Loudness" },
  { value: "tempo", label: "Tempo (fastest first)" },
  { value: "lastPlayed", label: "Last played" },
  { value: "plays", label: "Plays" },
];

/** "Play these N" appears once the list is NARROWED (a filter or a facet) —
 *  nobody means "replace the queue with 4,590 tracks" — and goes DISABLED
 *  above this many, with the reason in its tip: the verb replaces the queue,
 *  so the honest ceiling is a queue you would actually listen through, and
 *  queue writes are one call per track with no progress affordance, so
 *  fifty stays a few seconds where two hundred was a silent quarter minute
 *  (user call, 2026-09-01). */
// Sort + direction persist (view defaults); this is the session workspace —
// the filter, the facets and the scroll come back as they were left.
let tracksMem: {
  genre: string | null;
  decade: string | null;
  dr: string | null;
  /** The Tempo facet (0.12.0): a band's floor (lensShared's tempoBandOf), or null for any. */
  tempo: string | null;
  format: string | null;
  /** The Played facet (0.8.0): a playedBucket, or null for any. */
  played: string | null;
  filter: string;
  /** The filter's "search in" (0.13.0-rc.4): one field, or null for all of them; the session's,
   *  as the pickers are, so a later search never quietly misses what another field holds. */
  scope: FilterScope | null;
  scroll: number;
  /** The cards' spot, apart from the rows': a switch between them starts each at its own. */
  cardScroll: number;
} = {
  genre: null,
  decade: null,
  dr: null,
  tempo: null,
  format: null,
  played: null,
  filter: "",
  scope: null,
  scroll: 0,
  cardScroll: 0,
};

/**
 * THE TRACKS LENS (2026-09-01, user: "it feels like an obvious gap"): every
 * track across the ready indexes as one flat data list — the surface that
 * answers what Albums cannot ("my most dynamic tracks", "everything over ten
 * minutes"). Assembled from the lens parts the other two already use: the
 * filter-first sub-row with the Decade and Genre pickers, the sort chip,
 * TrackRow with a reserved DR cell, the Artists lens's selection and
 * drag-to-rail grammar, the shared track menu. Art leads each row (lazy,
 * one image per album through the cache); the second line links to the
 * album and the artist, as search results already do. The list is WINDOWED
 * — no cap to explain. DR comes from one bulk cache-only read, refreshed
 * when a sweep lands.
 * AS CARDS (0.13.0-rc.4, his picks on "Tracks as Cards"): with the Library's one Rows or Cards
 * choice on Cards, the list is a grid of track cards (TrackCards), and the lens's switch beside
 * the sort flips that one choice, as the Albums and Artists lenses' do. A card says the artist and
 * the album under the title, or, sorted by a figure a row shows in a cell of its own (the length,
 * DR, the year, the record's), that figure in place of the album.
 */
export function TracksLens({
  pools,
  actions,
  cards,
  cardSize,
  cardGap,
  fillRows,
}: {
  pools: MediaIndexPools[];
  actions: LensActions;
  /** The Tracks view's own Rows or Cards (lensTracksLayout, 0.13.0-rc.4: kept apart from the
   *  albums', his note on "View Options"). */
  cards: boolean;
  cardSize: number;
  cardGap: number;
  fillRows: boolean;
}): React.JSX.Element {
  const [mem, setMemState] = useState(tracksMem);
  const setMem = (patch: Partial<typeof tracksMem>): void => {
    tracksMem = { ...tracksMem, ...patch };
    setMemState(tracksMem);
  };
  const sortSetting = useStore((s) => s.settings.lensTracksSort);
  const reversed = useStore((s) => s.settings.lensTracksSortReversed);
  const play = usePlayStats();
  const trackSorts = play.ready
    ? TRACK_SORTS
    : TRACK_SORTS.filter((o) => !RECORD_SORTS.has(o.value));
  const sort = !play.ready && RECORD_SORTS.has(sortSetting) ? "title" : sortSetting;
  const saveSettings = useStore((s) => s.saveSettings);

  // what the lenses derive from the pools, once per snapshot (useLensIndex)
  const index = useLensIndex(pools);
  const all = index.tracks;
  const genreOptions = index.trackGenres;
  const decadeOptions = index.trackDecades;

  // Per-track DR: one bulk cache-only read (never a fetch), refreshed each
  // time a sweep finishes — the DR sort has its numbers without asking the
  // server for anything.
  const drKeys = useMemo(() => all.map((t) => audioAnalysisKey(t)), [all]);
  const statsByKey = useKnownStats(drKeys); // one home for known DR + loudness (lib/audioAnalysis)
  const drOf = (t: MediaNode): number | null => statsByKey[audioAnalysisKey(t)]?.dr ?? null;
  const lufsOf = (t: MediaNode): number | null => statsByKey[audioAnalysisKey(t)]?.lufs ?? null;
  // each card's format line, while Settings › Layout shows it, its DR the rows' DR
  const detailsOf = useTrackCardDetails((t) => ({ dr: drOf(t), lufs: lufsOf(t) }));
  // the tempo as Info says it, above its floor (the measured facts, 0.12.0)
  const tempoOf = (t: MediaNode): number | null => statsByKey[audioAnalysisKey(t)]?.bpm ?? null;
  const tempoOptions = useMemo(
    () => tempoOptionsOf(all.map((t) => tempoOf(t))),
    // tempoOf reads statsByKey; listing it keeps the memo honest
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, statsByKey],
  );
  const drOptions = useMemo(
    () => drOptionsOf(all.map((t) => drOf(t))),
    // drOf reads statsByKey; listing it keeps the memo honest
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, statsByKey],
  );
  const formatOptions = useMemo(
    () =>
      formatOptionsOf(
        all.flatMap((t) => formatTags(t.format)),
        all.length,
      ),
    [all],
  );

  // the listening record changes with every play: the list is filtered and sorted again on it
  // only while a sort or the Played facet reads it (0.12.0-rc.2, the 0.11 re-score)
  const record = RECORD_SORTS.has(sort) || mem.played ? play : null;
  const { shown, scopeCounts } = useMemo(() => {
    let list = all;
    if (mem.genre) list = list.filter((t) => (t.genre ?? []).some((g) => lc(g) === mem.genre));
    if (mem.decade) list = list.filter((t) => decadeOf(t.year) === mem.decade);
    if (mem.dr) list = list.filter((t) => String(drOf(t) ?? "") === mem.dr);
    if (mem.tempo) list = list.filter((t) => tempoBandOf(tempoOf(t)) === mem.tempo);
    // each row's tally read once, when a sort or the facet reads the record
    const tally = record ? talliesOf(record, list) : null;
    if (mem.played)
      list = list.filter((t) => playedBucket(tally?.get(t)?.lastAt ?? null) === mem.played);
    const fmt = mem.format;
    if (fmt) list = list.filter((t) => formatTags(t.format).includes(fmt));
    // the scope menu counts what each field would find among what the facets leave
    const scopeCounts = mem.filter ? filterScopeCounts(list, mem.filter) : null;
    if (mem.filter)
      list = list.filter((t) => matchesFilter(mem.filter, filterFields(t, mem.scope)));
    const byTitle = (a: MediaNode, b: MediaNode): number =>
      a.title.localeCompare(b.title) || (a.artist ?? "").localeCompare(b.artist ?? "");
    // album order: the album, then its running order (never compareTrackOrder
    // directly — the disc/position packing lives in trackPosition)
    const byAlbum = (a: MediaNode, b: MediaNode): number =>
      (a.album ?? "\uffff").localeCompare(b.album ?? "\uffff") ||
      (trackPosition(a) ?? 0) - (trackPosition(b) ?? 0) ||
      byTitle(a, b);
    const sorted = [...list].sort((a, b) => {
      if (sort === "artist")
        return (
          nameSortKey(a.artist ?? "\uffff").localeCompare(nameSortKey(b.artist ?? "\uffff")) ||
          byAlbum(a, b)
        );
      if (sort === "album") return byAlbum(a, b);
      if (sort === "year") return (b.year ?? "").localeCompare(a.year ?? "") || byAlbum(a, b);
      if (sort === "duration")
        return (b.durationSecs ?? 0) - (a.durationSecs ?? 0) || byTitle(a, b);
      if (sort === "dr") return (drOf(b) ?? -1) - (drOf(a) ?? -1) || byTitle(a, b);
      if (sort === "loudness") return (lufsOf(b) ?? -1000) - (lufsOf(a) ?? -1000) || byTitle(a, b);
      if (sort === "tempo") return (tempoOf(b) ?? -1) - (tempoOf(a) ?? -1) || byTitle(a, b);
      // the record's sorts: most recent / most played first, unplayed last
      if (sort === "lastPlayed")
        return (tally?.get(b)?.lastAt ?? 0) - (tally?.get(a)?.lastAt ?? 0) || byTitle(a, b);
      if (sort === "plays")
        return (tally?.get(b)?.plays ?? 0) - (tally?.get(a)?.plays ?? 0) || byTitle(a, b);
      return byTitle(a, b);
    });
    return { shown: reversed ? sorted.reverse() : sorted, scopeCounts };
    // drOf and lufsOf read statsByKey; listing it keeps the memo honest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, mem, sort, reversed, statsByKey, record]);
  const playedOptions = useMemo(
    () => (play.ready ? playedOptionsOf(all.map((t) => play.track(t)?.lastAt ?? null)) : []),
    [all, play],
  );
  /** The record's cell while sorted by it: plays, or how long ago. */
  const metaOf = (t: MediaNode): string | null | undefined => {
    if (sort === "plays") {
      const n = play.track(t)?.plays ?? 0;
      return n > 0 ? `${n} ${n === 1 ? "play" : "plays"}` : null;
    }
    if (sort === "lastPlayed") {
      const at = play.track(t)?.lastAt;
      return at != null ? fmtAgo(at) : null;
    }
    if (sort === "loudness") {
      const l = lufsOf(t);
      return l != null ? fmtLufs(l) : null;
    }
    if (sort === "tempo") {
      const bpm = tempoOf(t);
      return bpm != null ? `${bpm} bpm` : null;
    }
    return undefined;
  };
  /** A card's line under the title: the artist, and the album or the figure the list is sorted by. */
  const cardLineOf = (t: MediaNode): string => {
    const dr = sort === "dr" ? drOf(t) : null;
    const figure =
      sort === "duration"
        ? t.durationSecs != null
          ? fmtTime(t.durationSecs)
          : null
        : sort === "dr"
          ? dr != null
            ? `DR${dr}`
            : null
          : sort === "year"
            ? (t.year ?? null)
            : metaOf(t);
    return [t.artist, figure ?? t.album].filter(Boolean).join(FACT_SEP);
  };

  // WINDOWED LIST (2026-09-01, user: the cap read as a wall): render only
  // the rows near the viewport, so every sort over thousands of tracks stays
  // flat and nothing needs explaining. Rows are constant-height; the first
  // rendered one is measured, so the math never assumes a pixel. Selection,
  // ⌘A, shift-runs and drag operate on `shown` (the sorted list), never on
  // the rendered slice.
  const listRef = useRef<HTMLDivElement | null>(null);
  const total = shown.length;
  // the shared hook (hooks/useWindowedList, 2026-09-05): one kind of row,
  // always on — the lens has no cap, so the window is its only guarantee
  const win = useWindowedList({
    scrollRef: listRef,
    count: total,
    itemSelector: "[data-win-item]",
    estimate: 57,
    overscan: 8,
    enabled: !cards,
  });
  const start = win.first;
  const end = total === 0 ? 0 : win.last + 1;
  const narrowed = Boolean(
    mem.filter || mem.genre || mem.decade || mem.dr || mem.tempo || mem.format || mem.played,
  );
  const overCap = shown.length > PLAY_THESE_MAX;
  // CONSTANT GEOMETRY for the split button (user call, 2026-09-01: popping
  // on and off read as distraction; a standing slot invites the gesture):
  // always present, its STATE says what's missing — an invitation until the
  // list is narrowed, the cap's reason when too many, live gold when ready.
  const theseState: "invite" | "over" | "empty" | "live" = !narrowed
    ? "invite"
    : shown.length === 0
      ? "empty"
      : overCap
        ? "over"
        : "live";
  const theseTip =
    theseState === "invite"
      ? "Filter, or pick a decade, genre, DR or tempo, to play a set"
      : theseState === "over"
        ? `Narrow to ${fmtCount(PLAY_THESE_MAX)} tracks or fewer`
        : theseState === "empty"
          ? "Nothing matches those filters"
          : "Replaces the queue with these tracks";
  // what the narrowing IS, in words — the auto-named playlist and the
  // sweep's pulse both read it: '"love" · Rock · 2010s · DR13'
  const narrowing = [
    mem.filter
      ? `"${mem.filter.trim()}"${mem.scope ? ` in ${SCOPE_LABEL[mem.scope].toLowerCase()}s` : ""}`
      : null,
    mem.genre ? (genreOptions.find((g) => g.value === mem.genre)?.label ?? mem.genre) : null,
    mem.decade,
    mem.format ? (formatOptions.find((o) => o.value === mem.format)?.label ?? mem.format) : null,
    mem.dr ? `DR${mem.dr}` : null,
    mem.tempo ? tempoBandLabel(mem.tempo) : null,
  ]
    .filter(Boolean)
    .join(FACT_SEP);
  const [theseMenu, setTheseMenu] = useState<{ x: number; y: number } | null>(null);
  const windowed = shown.slice(start, end);

  // ---- selection (the Artists lens's grammar, over the VISIBLE rows)
  // the tracks column's selection, its drag to the nav and its plural menu:
  // useLensTrackSelection, shared with the other track lens (2026-09-13)
  const sel = useLensTrackSelection({ tracks: shown, actions });
  const { selT, setSelT, trackRowClick } = sel;

  // the list scrolls its own column; the spot survives a trip away (the cards' grid restores its
  // own, useCardGrid)
  useEffect(() => {
    const el = listRef.current;
    if (el) requestAnimationFrame(() => el.scrollTo({ top: tracksMem.scroll }));
  }, []);

  return (
    <div
      data-lens-tracks
      className="h-full min-h-0 flex flex-col"
      onClick={(e) => {
        // blank-space click clears the selection (the Finder rule)
        if (selT.size === 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        const t = e.target as HTMLElement;
        if (!e.currentTarget.contains(t)) return;
        if (t.closest("button, input, a, [data-library-track], [data-lens-selection-bar]")) return;
        setSelT(new Set());
      }}
    >
      <div className="flex items-start gap-3 pb-3 shrink-0">
        <div className="flex-1 min-w-0">
          {/* FILTER FIRST, then the facet pickers — the lens sub-row rule */}
          <div className={`flex flex-wrap items-center ${GAP_BETWEEN}`}>
            <FilterInput
              value={mem.filter}
              onChange={(filter) => setMem({ filter })}
              shown={shown.length}
              total={all.length}
              lead={
                <PickerPill
                  id="scope"
                  inline
                  neutral="All"
                  clearLabel="All fields"
                  clearCount={scopeCounts?.all}
                  options={SCOPES.map((v) => ({
                    value: v,
                    label: SCOPE_LABEL[v],
                    count: scopeCounts?.[v],
                  }))}
                  value={mem.scope}
                  onChange={(scope) => setMem({ scope: scope as FilterScope | null })}
                />
              }
            />
            <div className={`flex flex-wrap items-center ${GAP_WITHIN} empty:hidden`}>
              <PickerPill
                id="decade"
                neutral="Decade"
                clearLabel="All decades"
                options={decadeOptions}
                value={mem.decade}
                onChange={(decade) => setMem({ decade })}
              />
              <PickerPill
                id="genre"
                neutral="Genre"
                clearLabel="All genres"
                options={genreOptions}
                value={mem.genre}
                onChange={(genre) => setMem({ genre })}
              />
              <PickerPill
                id="format"
                neutral="Format"
                clearLabel="All formats"
                options={formatOptions}
                value={mem.format}
                onChange={(format) => setMem({ format })}
              />
              <PickerPill
                id="dr"
                neutral="DR"
                clearLabel="Any DR"
                options={drOptions}
                value={mem.dr}
                onChange={(dr) => setMem({ dr })}
                min={1}
              />
              <PickerPill
                id="tempo"
                neutral="Tempo"
                clearLabel="Any tempo"
                options={tempoOptions}
                value={mem.tempo}
                onChange={(tempo) => setMem({ tempo })}
                min={1}
              />
              <PickerPill
                id="played"
                neutral="Played"
                clearLabel="Any time"
                options={playedOptions}
                value={mem.played}
                onChange={(played) => setMem({ played })}
                min={1}
              />
            </div>
          </div>
        </div>
        <div className={`flex items-center ${GAP_WITHIN} shrink-0`}>
          {/* PLAY THESE BESIDE THE SORT (0.12.0, his call: with the Tempo facet the row wrapped and
              left the verb alone on a line): the facets wrap among themselves, the verb stays */}
          {/* the narrowed list as the queue, in one gesture — the album
              Play button's semantics (replaces the queue) for what's shown */}
          {
            // a SPLIT button: the one-click primary, and a chevron opening
            // the rest of what a shown list can become — the selection
            // bar's verbs applied to what's shown, plus the two the bar
            // lacks (user call, 2026-09-01: "the shown list behaves like a
            // selection")
            <div
              // at the row's right end, its tip opens leftward
              className="flex items-center tip-bottom tip-end"
              data-lens-these
              data-lens-these-state={theseState}
              data-tip={theseTip}
            >
              <PrimaryButton
                data-lens-play-these
                disabled={theseState !== "live"}
                onClick={() => actions.queueTracks(shown, "replace")}
                className="no-drag tip-bottom flex items-center gap-1.5 h-8 px-3 text-[12.5px] rounded-r-none"
              >
                <Play size={13} fill="currentColor" /> Play these
                {narrowed && shown.length > 0 ? ` ${fmtCount(shown.length)}` : ""}
              </PrimaryButton>
              <PrimaryButton
                data-lens-these-more
                aria-label="More for these tracks"
                disabled={theseState !== "live"}
                onClick={(e) => setTheseMenu(menuAt(e))}
                className="no-drag flex items-center h-8 px-2 rounded-l-none border-l border-bg/25 shadow-none"
              >
                <ChevronDown size={14} />
              </PrimaryButton>
            </div>
          }
          {/* View options beside sort, the Albums and Artists lenses' pairing */}
          <ViewOptions kind="tracks" />
          {/* the sort chip closes the row */}
          <SortChip
            sorts={trackSorts}
            neutral="title"
            value={sort}
            reversed={reversed}
            onChange={(v) =>
              void saveSettings({ lensTracksSort: v, lensTracksSortReversed: false })
            }
            onToggleReverse={() => void saveSettings({ lensTracksSortReversed: !reversed })}
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="text-[15px] text-faint pt-4 px-1">Nothing matches those filters.</div>
      ) : (
        <div className="relative flex-1 min-w-0 min-h-0 flex flex-col">
          <LensTrackSelectionBar sel={sel} className="bottom-2 inset-x-0 z-20" />
          {cards ? (
            <TrackCards
              tracks={shown}
              actions={actions}
              selected={selT}
              subtitleOf={cardLineOf}
              detailsOf={detailsOf}
              cardSize={cardSize}
              cardGap={cardGap}
              fillRows={fillRows}
              scrollTop={tracksMem.cardScroll}
              onScrolled={(top) => {
                tracksMem.cardScroll = top;
              }}
              onCardClick={trackRowClick}
              onNavDrag={(t, e) => sel.startTrackDrag(t, e)}
              onMenu={(t, e) => sel.rowMenu(t, e)}
              roomBelow={selT.size > 0}
            />
          ) : (
            <div
              ref={listRef}
              onScroll={(e) => {
                tracksMem.scroll = e.currentTarget.scrollTop;
              }}
              className={cx(
                "min-h-0 flex-1 overflow-y-auto px-1.5 -mx-1.5 -my-1",
                selT.size > 0 ? "pt-1 pb-24" : "py-1",
              )}
              data-lens-tracks-list
            >
              <div>
                {win.padTop > 0 && <div data-win-spacer="top" style={{ height: win.padTop }} />}
                <div>
                  {windowed.map((t, i) => {
                    const idx = start + i;
                    return (
                      <div key={nodeKey(t)} data-win-item className="border-b border-edge/50">
                        <TrackRow
                          node={t}
                          // art, not a running-order number: a track's position
                          // within its album reads as noise in a flat list
                          showArt
                          showPosition={false}
                          isCurrent={actions.isCurrentTrack(t)}
                          queued={actions.trackQueued(t)}
                          menuOpen={actions.menuNodeId === t.id}
                          favorited={actions.nodeFavorited(t)}
                          selected={selT.has(nodeKey(t))}
                          selStart={!(idx > 0 && selT.has(nodeKey(shown[idx - 1])))}
                          selEnd={!(idx < total - 1 && selT.has(nodeKey(shown[idx + 1])))}
                          dr={drOf(t)}
                          lufs={lufsOf(t)}
                          meta={metaOf(t)}
                          // the second line's links — the search-results
                          // treatment: the row plays, the names navigate
                          onAlbumLink={
                            actions.goToAlbum && t.album ? () => actions.goToAlbum?.(t) : undefined
                          }
                          onArtistLink={
                            actions.goToArtist && t.artist
                              ? () => actions.goToArtist?.(t)
                              : undefined
                          }
                          onRowClick={(e) => trackRowClick(t, e)}
                          onNavDrag={(e) => sel.startTrackDrag(t, e)}
                          onHeart={() => actions.heartNode(t)}
                          onPlayNow={(el) => actions.playTrack(t, el)}
                          onMenu={(e) => sel.rowMenu(t, e)}
                        />
                      </div>
                    );
                  })}
                </div>
                {win.padBottom > 0 && (
                  <div data-win-spacer="bottom" style={{ height: win.padBottom }} />
                )}
              </div>
            </div>
          )}
          <LensTrackMenu sel={sel} />
        </div>
      )}
      {theseMenu && (
        <RowMenu
          at={theseMenu}
          title={`${fmtCount(shown.length)} tracks${narrowing ? FACT_SEP + narrowing : ""}`}
          onClose={() => setTheseMenu(null)}
          items={[
            { label: "Play next", run: () => actions.queueTracks(shown, "next") },
            { label: "Add to end of queue", run: () => actions.queueTracks(shown, "append") },
            {
              label: "Add to playlist…",
              run: () => actions.addTracksToPlaylist(shown, theseMenu),
            },
            ...(actions.saveAsPlaylist
              ? [
                  {
                    label: "Save as playlist",
                    // the Queue's precedent: an auto name, the time making it
                    // unique in practice AND saying which session it was
                    run: () =>
                      actions.saveAsPlaylist?.(
                        shown,
                        `${narrowing || "Tracks"} — ${new Date().toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}`,
                      ),
                  },
                ]
              : []),
            ...(actions.analyzeTracks
              ? [
                  {
                    label: "Analyze audio",
                    // every shown track on the streamer's own server: the verb
                    // stays, disabled, with the reason (a mixed set runs for
                    // the readable ones)
                    ...(shown.every((n) => actions.unreadable(n))
                      ? { disabled: true, hint: USB_ANALYSIS_HINT }
                      : {}),
                    run: () =>
                      actions.analyzeTracks?.(
                        shown,
                        `${fmtCount(shown.length)} ${shown.length === 1 ? "track" : "tracks"}`,
                      ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {sel.dragGhost}
    </div>
  );
}
