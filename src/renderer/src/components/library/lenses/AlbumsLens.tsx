import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Heart,
  ListEnd,
  ListPlus,
  ListStart,
  Play,
  LayoutGrid,
  Rows3,
} from "lucide-react";
import {
  albumDrKey,
  albumTracksOf,
  albumVolume,
  isCompilation,
  type MediaIndexPools,
  type MediaNode,
  nameSortKey,
} from "@shared/model";
import { cx, matchesFilter, fmtCount } from "@/lib/format";
import { usePlayStats, playedBucket, playedOptionsOf } from "@/lib/playStats";
import { useStore } from "@/store";
import { useAlbumDr } from "@/lib/audioAnalysis";
import { FilterInput } from "@/components/controls/FilterInput";
import { HeaderChip, GAP_BETWEEN, GAP_WITHIN } from "@/components/chrome/Chrome";
import { SortChip } from "@/components/controls/SortChip";
import { PickerPill } from "@/components/controls/PickerPill";
import { Segmented } from "@/components/controls/Segmented";
import { ContainerCard, ContainerRow } from "@/components/library/LibraryCards";
import { SelectionBar, SelectionVerb } from "@/components/controls/SelectionBar";
import {
  type LensActions,
  lc,
  nodeKey,
  genreOptionsOf,
  decadeOptionsOf,
  drOptionsOf,
  formatTags,
  formatOptionsOf,
  RECORD_SORTS,
  PLAY_THESE_MAX,
} from "./lensShared";

// The Albums lens, split out of LibraryLenses.tsx (2026-09-13, the lenses round: three lenses of
// 600 to 800 lines shared one file); what the lenses share lives in ./lensShared.

const ALBUM_SORTS: Array<{
  value: "title" | "artist" | "year" | "dr" | "loudness" | "lastPlayed" | "plays" | "wholeListens";
  label: string;
}> = [
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "year", label: "Year (newest first)" },
  { value: "dr", label: "Dynamic range" },
  { value: "loudness", label: "Loudness" },
  { value: "lastPlayed", label: "Last played" },
  { value: "plays", label: "Most played" },
  { value: "wholeListens", label: "Whole listens" },
];

// Sort + direction live in settings (view defaults persist, 2026-08-06);
// what stays here is session workspace — filters, and the browse spot come
// back as they were left, and die with the app.
let albumsMem: {
  genre: string | null;
  decade: string | null;
  dr: string | null;
  format: string | null;
  /** The Played facet (0.8.0): a playedBucket, or null for any. */
  played: string | null;
  filter: string;
} = { genre: null, decade: null, dr: null, format: null, played: null, filter: "" };

/** The queue write's cap, shared by Play these and the album selection bar (user
 *  call, 2026-09-01 / 2026-09-02): queue writes are one call per track with no
 *  progress affordance, so no gesture may hand the queue fifty albums. */

export function AlbumsLens({
  pools,
  actions,
  cards,
  cardSize,
  cardGap,
  fillRows,
  onToggleLayout,
}: {
  pools: MediaIndexPools[];
  actions: LensActions;
  cards: boolean;
  cardSize: number;
  cardGap: number;
  fillRows: boolean;
  /** Flips libraryLayout — sort and layout are one presentation pairing
   *  (adjacent in the browse header), kept together here too. */
  onToggleLayout?: () => void;
}): React.JSX.Element {
  const [mem, setMemState] = useState(albumsMem);
  const setMem = (patch: Partial<typeof albumsMem>): void => {
    albumsMem = { ...albumsMem, ...patch };
    setMemState(albumsMem);
  };
  const sortSetting = useStore((s) => s.settings.lensAlbumsSort);
  const reversed = useStore((s) => s.settings.lensAlbumsSortReversed);
  // the listening record's reading surfaces (0.8.0): an album's plays are the
  // fold of its tracks' plays (so a compilation's land on the compilation)
  const play = usePlayStats();
  // the record's sorts exist only while stats do; a persisted one falls back
  // to title until they return (the setting itself is left alone)
  const albumSorts = play.ready
    ? ALBUM_SORTS
    : ALBUM_SORTS.filter((o) => !RECORD_SORTS.has(o.value));
  const sort = !play.ready && RECORD_SORTS.has(sortSetting) ? "title" : sortSetting;
  const saveSettings = useStore((s) => s.saveSettings);
  const albumDr = useAlbumDr();

  const all = useMemo(() => pools.flatMap((g) => g.albums), [pools]);
  const multiServer = useMemo(() => pools.filter((g) => g.albums.length > 0).length > 1, [pools]);

  // Facets from the data itself — the builders are shared with the Tracks
  // lens (genreOptionsOf / decadeOptionsOf); pickers render only when they
  // would actually distinguish (>=2 options).
  const genreOptions = useMemo(() => genreOptionsOf(all), [all]);
  const decadeOptions = useMemo(() => decadeOptionsOf(all), [all]);
  const drOptions = useMemo(
    () => drOptionsOf(all.map((a) => albumDr[albumDrKey(a)]?.dr ?? null)),
    [all, albumDr],
  );
  // an album's codecs = the union over its tracks in the pool (a mixed album
  // matches every codec it holds, the way Genre aggregates)
  const albumCodecs = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const g of pools)
      for (const t of g.tracks) {
        const tags = formatTags(t.format);
        if (!t.album || tags.length === 0) continue;
        const k = `${g.udn}|${lc(t.album)}`;
        const set = m.get(k) ?? new Set<string>();
        for (const tag of tags) set.add(tag);
        m.set(k, set);
      }
    return m;
  }, [pools]);
  const formatOptions = useMemo(
    () =>
      formatOptionsOf(
        all.flatMap((a) => [...(albumCodecs.get(`${a.serverUdn}|${lc(a.title)}`) ?? [])]),
        all.length,
      ),
    [all, albumCodecs],
  );
  const albumPlay = useMemo(() => {
    const m = new Map<string, { plays: number; lastAt: number | null; whole: number }>();
    if (!play.ready) return m;
    // an album's tracks together: plays and last played fold per track, and
    // the WHOLE listens are the record's runs against this track set
    const groups = new Map<string, MediaNode[]>();
    for (const g of pools)
      for (const t of g.tracks) {
        if (!t.album) continue;
        const k = `${g.udn}|${lc(t.album)}`;
        const list = groups.get(k);
        if (list) list.push(t);
        else groups.set(k, [t]);
      }
    for (const [k, tracks] of groups) {
      const a = play.album(tracks);
      if (a.plays > 0 || a.whole > 0)
        m.set(k, { plays: a.plays, lastAt: a.lastAt, whole: a.whole });
    }
    return m;
  }, [pools, play]);
  const playOf = (a: MediaNode): { plays: number; lastAt: number | null; whole: number } =>
    albumPlay.get(`${a.serverUdn}|${lc(a.title)}`) ?? { plays: 0, lastAt: null, whole: 0 };
  const playedOptions = useMemo(
    () => (play.ready ? playedOptionsOf(all.map((a) => playOf(a).lastAt)) : []),
    // playOf reads albumPlay; listing it keeps the memo honest
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, albumPlay, play.ready],
  );

  // Compilation = named so by its album artist, or (tracks known) credited to
  // an album artist none of its performers is; "Daft Punk feat. …" is not.
  const kind = useStore((s) => s.settings.lensAlbumsKind);
  const compilationKeys = useMemo(() => {
    const byAlbum = new Map<string, MediaNode[]>();
    for (const g of pools)
      for (const t of g.tracks) {
        if (!t.album) continue;
        const k = `${g.udn}|${lc(t.album)}`;
        const list = byAlbum.get(k);
        if (list) list.push(t);
        else byAlbum.set(k, [t]);
      }
    const keys = new Set<string>();
    for (const a of all)
      if (isCompilation(a, byAlbum.get(`${a.serverUdn}|${lc(a.title)}`))) keys.add(nodeKey(a));
    return keys;
  }, [pools, all]);

  const shown = useMemo(() => {
    let list = all;
    if (kind === "compilations") list = list.filter((a) => compilationKeys.has(nodeKey(a)));
    else if (kind === "albums") list = list.filter((a) => !compilationKeys.has(nodeKey(a)));
    if (mem.genre) list = list.filter((a) => (a.genre ?? []).some((g) => lc(g) === mem.genre));
    if (mem.decade)
      list = list.filter(
        (a) => a.year != null && `${Math.floor(Number(a.year) / 10) * 10}s` === mem.decade,
      );
    if (mem.dr) list = list.filter((a) => String(albumDr[albumDrKey(a)]?.dr ?? "") === mem.dr);
    if (mem.played) list = list.filter((a) => playedBucket(playOf(a).lastAt) === mem.played);
    const fmt = mem.format;
    if (fmt)
      list = list.filter(
        (a) => albumCodecs.get(`${a.serverUdn}|${lc(a.title)}`)?.has(fmt) ?? false,
      );
    if (mem.filter)
      list = list.filter((a) => matchesFilter(mem.filter, [a.title, a.artist, a.year]));
    const sorted = [...list].sort((a, b) => {
      if (sort === "artist")
        return (
          nameSortKey(a.artist ?? "￿").localeCompare(nameSortKey(b.artist ?? "￿")) ||
          a.title.localeCompare(b.title)
        );
      if (sort === "year")
        return (b.year ?? "").localeCompare(a.year ?? "") || a.title.localeCompare(b.title);
      if (sort === "dr") {
        // analyzed albums first, most dynamic leading; the rest alphabetical
        const d = (n: MediaNode): number => albumDr[albumDrKey(n)]?.dr ?? -1;
        return d(b) - d(a) || a.title.localeCompare(b.title);
      }
      if (sort === "loudness") {
        // measured albums first, loudest leading; unmeasured alphabetical after
        const l = (n: MediaNode): number => albumDr[albumDrKey(n)]?.lufs ?? -1000;
        return l(b) - l(a) || a.title.localeCompare(b.title);
      }
      // the record's sorts: most recent / most played first, unplayed last
      if (sort === "lastPlayed")
        return (playOf(b).lastAt ?? 0) - (playOf(a).lastAt ?? 0) || a.title.localeCompare(b.title);
      if (sort === "plays")
        return playOf(b).plays - playOf(a).plays || a.title.localeCompare(b.title);
      if (sort === "wholeListens")
        return (
          playOf(b).whole - playOf(a).whole ||
          playOf(b).plays - playOf(a).plays ||
          a.title.localeCompare(b.title)
        );
      return (
        a.title.localeCompare(b.title) || (a.serverName ?? "").localeCompare(b.serverName ?? "")
      );
    });
    return reversed ? sorted.reverse() : sorted;
    // playOf reads albumPlay; listing it keeps the memo honest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, mem, sort, reversed, kind, compilationKeys, albumDr, albumCodecs, albumPlay]);

  /**
   * Box sets (2026-08-24): volume siblings — same parsed base + artist, ≥2
   * members with trailing Disc/Vol/Part markers — collapse to ONE tile at
   * the first member's position, ordered by volume. Two same-titled
   * EDITIONS never match (no marker). The tile opens volume 1; the album
   * header's set line walks the rest.
   */
  const tiles = useMemo(() => {
    const groups = new Map<string, MediaNode[]>();
    for (const n of shown) {
      const v = albumVolume(n.title);
      if (!v) continue;
      const k = `${lc(v.base)}|${lc(n.albumArtist ?? n.artist ?? "")}`;
      const list = groups.get(k);
      if (list) list.push(n);
      else groups.set(k, [n]);
    }
    const seen = new Set<string>();
    const out: Array<{ node: MediaNode; set?: { base: string; volumes: MediaNode[] } }> = [];
    for (const n of shown) {
      const v = albumVolume(n.title);
      const k = v ? `${lc(v.base)}|${lc(n.albumArtist ?? n.artist ?? "")}` : null;
      const g = k ? groups.get(k) : undefined;
      if (!v || !g || g.length < 2) {
        out.push({ node: n });
        continue;
      }
      if (seen.has(k as string)) continue;
      seen.add(k as string);
      const volumes = [...g].sort(
        (a, b) => (albumVolume(a.title)?.volume ?? 0) - (albumVolume(b.title)?.volume ?? 0),
      );
      out.push({ node: volumes[0], set: { base: v.base, volumes } });
    }
    return out;
  }, [shown]);

  // ALBUM MULTI-SELECT (0.8.0): the tracks' grammar on the album tiles. Keyed by
  // nodeKey over the TILES (a box set is one tile, one pick, every volume of it
  // in the batch); ⌘/ctrl-click toggles, shift-click ranges from the anchor,
  // a bare click in selection mode clears instead of opening, Esc clears, ⌘A
  // takes every tile shown, a click on the nav rail or the bar clears. The
  // selection prunes itself to the tiles still shown when the facets move.
  const [selA, setSelA] = useState<ReadonlySet<string>>(() => new Set());
  const selAAnchor = useRef<number | null>(null);
  const tileKeys = useMemo(() => tiles.map((t) => nodeKey(t.node)), [tiles]);
  useEffect(() => {
    setSelA((prev) => {
      if (prev.size === 0) return prev;
      const keep = new Set(tileKeys);
      const next = new Set([...prev].filter((k) => keep.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [tileKeys]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target;
      if (t instanceof HTMLElement && t.matches("input, textarea, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        if (tileKeys.length === 0) return;
        e.preventDefault();
        setSelA(new Set(tileKeys));
        return;
      }
      if (selA.size === 0) return;
      if (e.key === "Escape") setSelA(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tileKeys, selA.size]);
  useEffect(() => {
    if (selA.size === 0) return;
    const onWin = (e: MouseEvent): void => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (!t.closest("[data-app-nav], [data-app-playbar]")) return;
      if (t.closest("button, input, a, [aria-valuenow]")) return;
      setSelA(new Set());
    };
    window.addEventListener("click", onWin);
    return () => window.removeEventListener("click", onWin);
  }, [selA.size]);
  /** True = the click was a selection chord; the caller must not open. */
  const albumClick = (raw: MediaNode, e: React.MouseEvent): boolean => {
    const key = nodeKey(raw);
    const idx = tileKeys.indexOf(key);
    if (e.metaKey || e.ctrlKey) {
      setSelA((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      selAAnchor.current = idx;
      return true;
    }
    if (e.shiftKey && selAAnchor.current != null && idx >= 0) {
      const [a, b] = [Math.min(selAAnchor.current, idx), Math.max(selAAnchor.current, idx)];
      setSelA(new Set(tileKeys.slice(a, b + 1)));
      return true;
    }
    if (selA.size > 0) {
      setSelA(new Set());
      return true;
    }
    return false;
  };
  /** The picked albums as containers, a set's volumes in order. */
  const chosenA = (): MediaNode[] =>
    tiles
      .filter((t) => selA.has(nodeKey(t.node)))
      .flatMap((t) => (t.set ? t.set.volumes : [t.node]));
  /** The same, expanded to tracks from the index (the queue and playlist verbs
   *  want tracks, and the cap counts them). */
  const chosenATracks = (): MediaNode[] =>
    chosenA().flatMap((alb) => {
      const pool = pools.find((g) => g.udn === alb.serverUdn);
      return pool ? albumTracksOf(alb, pool) : [];
    });
  const selATrackCount = useMemo(
    () => (selA.size === 0 ? 0 : chosenATracks().length),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chosenATracks reads selA and tiles, both listed
    [selA, tiles, pools],
  );
  const selAOverCap = selATrackCount > PLAY_THESE_MAX;
  const capTip = `Choose albums that come to ${fmtCount(PLAY_THESE_MAX)} tracks or fewer`;
  /** A drag from a picked tile carries the whole selection (under the cap; over
   *  it, the pressed album alone, so the queue is never handed too much). */
  const startAlbumTileDrag = (
    raw: MediaNode,
    set: { volumes: MediaNode[] } | null | undefined,
    title: string,
    e: React.PointerEvent,
  ): void => {
    if (selA.has(nodeKey(raw)) && selA.size > 1 && !selAOverCap) {
      actions.dragAlbum(chosenA(), e, `${fmtCount(selA.size)} albums`, "albums");
      return;
    }
    actions.dragAlbum(set ? set.volumes : [raw], e, title);
  };
  return (
    <div data-lens-albums>
      <div className="flex items-start gap-3 pb-3">
        <div className="flex-1 min-w-0">
          {/* one row: filter, partition, then the two facet PICKERS.
              Genre joined Decade as a PickerPill (user, 2026-08-31): real
              tag data made the chip rail read as overwhelm — dozens of
              genres spending rows — and the bounded picker already owned
              the same job for decades. The rail pattern retired with it. */}
          <div className={`flex flex-wrap items-center ${GAP_BETWEEN}`}>
            {/* FILTER FIRST, on the LEFT — the lens sub-row rule (user
                call 2026-08-16, matching the Artists lens): text filter,
                then the partition, then the facets; the sort chip sits
                alone on the right. This filter used to sit right, beside
                the sort chip — the one text filter in the app next to a
                sort control, and its sibling lens did the opposite. */}
            <FilterInput
              value={mem.filter}
              onChange={(filter) => setMem({ filter })}
              shown={shown.length}
              total={all.length}
            />
            {/* the PARTITION follows: everything · artist albums ·
                compilations. A view default — it persists (S12). */}
            <Segmented<"all" | "albums" | "compilations">
              value={kind}
              onChange={(v) => void saveSettings({ lensAlbumsKind: v })}
              options={[
                { value: "all", label: "All" },
                { value: "albums", label: "Albums" },
                { value: "compilations", label: "Compilations", tip: "Various-artists albums" },
              ]}
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
              {/* the DR facet appears with the first analyzed album (user,
                2026-09-01: "show me all my DR13") */}
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
          {/* layout beside sort — the browse header's presentation pairing
              ("alone on the right" bars filters and facets, not sort's own
              established partner) */}
          {onToggleLayout && (
            <HeaderChip
              data-tip={cards ? "Albums as rows" : "Albums as cards"}
              aria-label={cards ? "Albums as rows" : "Albums as cards"}
              onClick={onToggleLayout}
              className="no-drag tip-bottom p-2 motion-safe:active:scale-90"
            >
              {cards ? <Rows3 size={16} /> : <LayoutGrid size={16} />}
            </HeaderChip>
          )}
          <SortChip
            sorts={albumSorts}
            neutral="title"
            value={sort}
            reversed={reversed}
            onChange={(v) =>
              void saveSettings({ lensAlbumsSort: v, lensAlbumsSortReversed: false })
            }
            onToggleReverse={() => void saveSettings({ lensAlbumsSortReversed: !reversed })}
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="text-[15px] text-faint pt-4 px-1">Nothing matches those filters.</div>
      ) : (
        <div
          className={cx(
            !cards && "divide-y divide-edge/50 -mx-2",
            // selection mode adds scroll-room under the floating bar (the S45 rule)
            selA.size > 0 && "pb-24",
          )}
          style={
            cards
              ? {
                  display: "grid",
                  gridTemplateColumns: fillRows
                    ? `repeat(auto-fill, minmax(${cardSize}px, 1fr))`
                    : `repeat(auto-fill, ${cardSize}px)`,
                  gap: cardGap,
                  paddingTop: 8,
                }
              : undefined
          }
        >
          {tiles.map(({ node: rawNode, set }, ti) => {
            // a set tile is volume 1 wearing the base title and a count badge
            const node = set ? { ...rawNode, title: set.base, year: null } : rawNode;
            return cards ? (
              <ContainerCard
                key={nodeKey(rawNode)}
                node={node}
                playing={
                  set
                    ? set.volumes.some((v) => actions.isPlayingAlbum(v))
                    : actions.isPlayingAlbum(node)
                }
                menuOpen={actions.menuNodeId === node.id}
                favorited={actions.nodeFavorited(rawNode)}
                badge={
                  set ? `${set.volumes.length} volumes` : multiServer ? node.serverName : undefined
                }
                selected={selA.has(nodeKey(rawNode))}
                onHeart={() => actions.heartNode(rawNode)}
                onEnter={(e) => {
                  if (albumClick(rawNode, e)) return;
                  actions.openAlbum(rawNode);
                }}
                onPlay={(el) => void actions.playContainer(rawNode, el)}
                onMenu={(e) => actions.openMenu(rawNode, e)}
                onNavDrag={(e) => startAlbumTileDrag(rawNode, set, node.title, e)}
              />
            ) : (
              <ContainerRow
                key={nodeKey(rawNode)}
                node={node}
                selected={selA.has(nodeKey(rawNode))}
                selStart={!(ti > 0 && selA.has(tileKeys[ti - 1]))}
                selEnd={!(ti < tileKeys.length - 1 && selA.has(tileKeys[ti + 1]))}
                playing={
                  set
                    ? set.volumes.some((v) => actions.isPlayingAlbum(v))
                    : actions.isPlayingAlbum(node)
                }
                menuOpen={actions.menuNodeId === node.id}
                favorited={actions.nodeFavorited(rawNode)}
                badge={
                  set ? `${set.volumes.length} volumes` : multiServer ? node.serverName : undefined
                }
                dr={albumDr[albumDrKey(node)]?.dr ?? null}
                onArtistLink={
                  actions.goToArtist && node.artist ? () => actions.goToArtist?.(node) : undefined
                }
                onHeart={() => actions.heartNode(rawNode)}
                onEnter={(e) => {
                  if (albumClick(rawNode, e)) return;
                  actions.openAlbum(rawNode);
                }}
                onMenu={(e) => actions.openMenu(rawNode, e)}
                onNavDrag={(e) => startAlbumTileDrag(rawNode, set, node.title, e)}
              />
            );
          })}
        </div>
      )}
      {selA.size > 0 && (
        <SelectionBar
          count={selA.size}
          onClear={() => setSelA(new Set())}
          className="bottom-2 inset-x-0 z-20"
          data-albums-selection-bar
        >
          <SelectionVerb
            icon={<Play size={13} />}
            disabled={selAOverCap}
            data-tip={selAOverCap ? capTip : undefined}
            className={cx(selAOverCap && "tip-top opacity-50")}
            onClick={() =>
              actions.queueTracks(chosenATracks(), "replace", () => setSelA(new Set()))
            }
          >
            Play
          </SelectionVerb>
          <SelectionVerb
            icon={<ListStart size={13} />}
            disabled={selAOverCap}
            data-tip={selAOverCap ? capTip : undefined}
            className={cx(selAOverCap && "tip-top opacity-50")}
            onClick={() => actions.queueTracks(chosenATracks(), "next", () => setSelA(new Set()))}
          >
            Play next
          </SelectionVerb>
          <SelectionVerb
            icon={<ListEnd size={13} />}
            disabled={selAOverCap}
            data-tip={selAOverCap ? capTip : undefined}
            className={cx(selAOverCap && "tip-top opacity-50")}
            onClick={() => actions.queueTracks(chosenATracks(), "append", () => setSelA(new Set()))}
          >
            Add to end of queue
          </SelectionVerb>
          <SelectionVerb
            icon={<ListPlus size={13} />}
            onClick={(e) =>
              actions.addTracksToPlaylist(chosenATracks(), { x: e.clientX, y: e.clientY }, () =>
                setSelA(new Set()),
              )
            }
          >
            Add to playlist…
          </SelectionVerb>
          {(() => {
            const nodes = chosenA();
            const allIn = nodes.length > 0 && nodes.every(actions.nodeFavorited);
            return (
              <SelectionVerb
                icon={<Heart size={13} fill={allIn ? "currentColor" : "none"} />}
                onClick={() => actions.heartNodes(nodes, allIn)}
              >
                {allIn ? "Remove from favorites" : "Add to favorites"}
              </SelectionVerb>
            );
          })()}
          <SelectionVerb
            icon={<AudioLines size={13} />}
            onClick={() => {
              actions.analyzeAlbums(chosenA());
              setSelA(new Set());
            }}
          >
            Analyze audio
          </SelectionVerb>
          <span className="shrink-0 py-px text-faint tabular-nums mt-[3px] text-[11.5px]">
            {fmtCount(selATrackCount)} {selATrackCount === 1 ? "track" : "tracks"}
          </span>
        </SelectionBar>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ artists
