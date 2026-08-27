import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, MoreHorizontal } from "lucide-react";
import {
  albumFormat,
  orderTracks,
  discGroups,
  isCompilation,
  performerLine,
  sameArt,
  trackArtists,
  trackInAlbumOf,
  type MediaIndexPools,
  type MediaNode,
  nameSortKey,
} from "@shared/model";
import { cx, fmtTime, matchesFilter } from "@/lib/format";
import { useStore } from "@/store";
import { scrollToVisible } from "@/lib/scroll";
import { isAlbumClass } from "@/lib/media";
import { MediaArt } from "@/components/media/MediaArt";
import { FilterInput } from "@/components/controls/FilterInput";
import { PopoverChrome } from "@/hooks/usePopover";
import { POPOVER_CARD } from "@/components/chrome/Overlay";
import { Chip } from "@/components/chrome/Chrome";
import { SortChip } from "@/components/controls/SortChip";
import { Segmented } from "@/components/controls/Segmented";
import { ContainerCard, ContainerRow, TrackRow } from "@/components/library/LibraryCards";
import { Eqbars } from "@/components/media/Eqbars";

// The library lenses: OUR views over the union of every ready index —
// alternative paths to the same leaf views the native flow uses, never a
// parallel world. The root offers them beside the source doors (places, not
// modes). Both lenses keep their state in module scope for the session, the
// scrollMemory pattern: leaving for an album and crumbing back restores the
// exact spot.

/** Everything a lens needs from LibraryScreen — all node-based, and every
 *  node here carries a serverUdn/serverName stamp, so the screen's existing
 *  stamp-aware handlers work unchanged. */
export interface LensActions {
  /** Open the shared native album leaf (plants the lens crumb for the way back). */
  openAlbum(node: MediaNode): void;
  playTrack(node: MediaNode, el: HTMLElement | null): void;
  playContainer(node: MediaNode, el: HTMLElement | null): void;
  openMenu(node: MediaNode, e: React.MouseEvent): void;
  menuNodeId: string | null;
  heartNode(node: MediaNode): void;
  nodeFavorited(node: MediaNode): boolean;
  trackQueued(node: MediaNode): boolean;
  isCurrentTrack(node: MediaNode): boolean;
  isPlayingAlbum(node: MediaNode): boolean;
  /** The playing track's artist while the queue source is live — cheap
   *  content identity for the artists column (no per-render track scans). */
  playingArtist: string | null;
}

const lc = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();
const nodeKey = (n: MediaNode): string => `${n.serverUdn ?? ""}|${n.id}`;

/** Facet chips, the radio-category pill idiom: single-select, click the
 *  active chip to clear (facet-shaped data may earn multi-select someday —
 *  see the partition-vs-facet note in the ROADMAP — but it starts here).
 *  With `max`, the rail shows the top chips and folds the tail behind a
 *  "+N more" popover — real tag data grows genre lists without bound, and
 *  a hard cap would silently strand whatever fell off. The active value
 *  always surfaces in the rail, even when picked from the tail. */
function ChipRail({
  rail,
  options,
  value,
  max,
  lead,
  onChange,
}: {
  rail: string;
  options: Array<{ value: string; label: string; count: number }>;
  value: string | null;
  max?: number;
  /** A leading control sharing the row (the decade picker pill). */
  lead?: React.ReactNode;
  onChange(value: string | null): void;
}): React.JSX.Element | null {
  const [moreOpen, setMoreOpen] = useState(false);
  const showChips = options.length >= 2;
  if (!showChips && lead == null) return null;
  let visible = max != null && options.length > max ? options.slice(0, max) : options;
  if (value && !visible.some((o) => o.value === value)) {
    const active = options.find((o) => o.value === value);
    if (active) visible = [...visible.slice(0, -1), active];
  }
  const moreCount = options.length - visible.length;
  const chip = (o: { value: string; label: string; count: number }): React.JSX.Element => (
    <Chip
      key={o.value}
      state={value === o.value ? "active" : "idle"}
      data-lens-chip={o.label}
      onClick={() => {
        onChange(value === o.value ? null : o.value);
        setMoreOpen(false);
      }}
      className="no-drag motion-safe:active:scale-95"
    >
      {o.label}
      <span
        className={cx(
          "ml-1.5 font-mono text-[10px]",
          value === o.value ? "text-gold/70" : "text-faint",
        )}
      >
        {o.count}
      </span>
    </Chip>
  );
  return (
    <div data-lens-rail={rail} className="flex items-center gap-1.5 flex-wrap">
      {lead}
      {showChips && visible.map(chip)}
      {showChips && moreCount > 0 && (
        <div className="relative">
          <Chip
            state={moreOpen ? "open" : "idle"}
            data-lens-more={rail}
            onClick={() => setMoreOpen((o) => !o)}
            className="no-drag motion-safe:active:scale-95"
          >
            +{moreCount} more
          </Chip>
          {moreOpen && (
            <>
              <PopoverChrome onClose={() => setMoreOpen(false)} />
              <div className="fixed inset-0 z-20" onClick={() => setMoreOpen(false)} />
              <div
                data-lens-more-popover
                className={cx(
                  "absolute left-0 top-full mt-1.5 z-30 w-56 max-h-72 overflow-y-auto",
                  POPOVER_CARD,
                  "p-1.5 space-y-0.5",
                )}
              >
                {options.map((o) => (
                  <button
                    key={o.value}
                    data-lens-chip={o.label}
                    onClick={() => {
                      onChange(value === o.value ? null : o.value);
                      setMoreOpen(false);
                    }}
                    className={cx(
                      "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[13px] transition-colors",
                      value === o.value
                        ? "text-gold bg-golddim"
                        : "text-dim hover:text-ink hover:bg-veil",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    <span className="font-mono text-[10.5px] text-faint tabular-nums">
                      {o.count}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One pill that opens a picker popover — for bounded facets (decades) that
 *  shouldn't spend a whole rail row. The chevron marks it as a picker, not a
 *  toggle chip; an active pick renders gold like any active chip. Clicking the
 *  active option still toggles it off, but a picker popover reads as
 *  "choose one" — the explicit clear row is the discoverable way back out. */
function PickerPill({
  id,
  neutral,
  clearLabel,
  options,
  value,
  onChange,
}: {
  id: string;
  neutral: string;
  clearLabel: string;
  options: Array<{ value: string; label: string; count: number }>;
  value: string | null;
  onChange(value: string | null): void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (options.length < 2) return null;
  const active = value ? options.find((o) => o.value === value) : null;
  return (
    <div className="relative">
      <Chip
        state={active ? "active" : open ? "open" : "idle"}
        data-lens-picker={id}
        onClick={() => setOpen((o) => !o)}
        className="no-drag flex items-center gap-1 motion-safe:active:scale-95"
      >
        {active ? active.label : neutral}
        <ChevronDown size={12} className={active ? "text-gold/70" : "text-faint"} />
      </Chip>
      {open && (
        <>
          <PopoverChrome onClose={() => setOpen(false)} />
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            data-lens-picker-popover={id}
            className={cx(
              "absolute left-0 top-full mt-1.5 z-30 w-44 max-h-72 overflow-y-auto",
              POPOVER_CARD,
              "p-1.5 space-y-0.5",
            )}
          >
            <button
              data-lens-chip={clearLabel}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className={cx(
                "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[13px] transition-colors",
                value === null ? "text-gold bg-golddim" : "text-dim hover:text-ink hover:bg-veil",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{clearLabel}</span>
            </button>
            {options.map((o) => (
              <button
                key={o.value}
                data-lens-chip={o.label}
                onClick={() => {
                  onChange(value === o.value ? null : o.value);
                  setOpen(false);
                }}
                className={cx(
                  "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[13px] transition-colors",
                  value === o.value
                    ? "text-gold bg-golddim"
                    : "text-dim hover:text-ink hover:bg-veil",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <span className="font-mono text-[10.5px] text-faint tabular-nums">{o.count}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- albums

const ALBUM_SORTS: Array<{ value: "title" | "artist" | "year"; label: string }> = [
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "year", label: "Year (newest first)" },
];

// Sort + direction live in settings (view defaults persist, 2026-08-06);
// what stays here is session workspace — filters, and the browse spot come
// back as they were left, and die with the app.
let albumsMem: {
  genre: string | null;
  decade: string | null;
  filter: string;
} = { genre: null, decade: null, filter: "" };

export function AlbumsLens({
  pools,
  actions,
  cards,
  cardSize,
  cardGap,
  fillRows,
}: {
  pools: MediaIndexPools[];
  actions: LensActions;
  cards: boolean;
  cardSize: number;
  cardGap: number;
  fillRows: boolean;
}): React.JSX.Element {
  const [mem, setMemState] = useState(albumsMem);
  const setMem = (patch: Partial<typeof albumsMem>): void => {
    albumsMem = { ...albumsMem, ...patch };
    setMemState(albumsMem);
  };
  const sort = useStore((s) => s.settings.lensAlbumsSort);
  const reversed = useStore((s) => s.settings.lensAlbumsSortReversed);
  const saveSettings = useStore((s) => s.saveSettings);

  const all = useMemo(() => pools.flatMap((g) => g.albums), [pools]);
  const multiServer = useMemo(() => pools.filter((g) => g.albums.length > 0).length > 1, [pools]);

  // Facets from the data itself: genres by count (raw tagger strings,
  // case-normalized by key), decades from dc:date years. Rails render only
  // when they'd actually distinguish (≥2 options).
  const genreOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const a of all) {
      for (const g of a.genre ?? []) {
        const k = lc(g);
        const cur = counts.get(k);
        if (cur) cur.count++;
        else counts.set(k, { label: g, count: 1 });
      }
    }
    // no cap here: the rail's `max` shows the top chips and the +N-more
    // popover carries the whole tail — capping OPTIONS would strand genres
    return [...counts.entries()]
      .map(([value, x]) => ({ value, ...x }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [all]);
  const decadeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of all) {
      if (!a.year) continue;
      const d = `${Math.floor(Number(a.year) / 10) * 10}s`;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => b.value.localeCompare(a.value));
  }, [all]);

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
      return (
        a.title.localeCompare(b.title) || (a.serverName ?? "").localeCompare(b.serverName ?? "")
      );
    });
    return reversed ? sorted.reverse() : sorted;
  }, [all, mem, sort, reversed, kind, compilationKeys]);

  return (
    <div data-lens-albums>
      <div className="flex items-start gap-3 pb-3">
        <div className="flex-1 min-w-0">
          {/* one row: the decade picker leads, genres chip along after it —
              a bounded facet doesn't get to spend a whole rail row */}
          <ChipRail
            rail="genre"
            options={genreOptions}
            value={mem.genre}
            max={8}
            lead={
              <>
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
                <PickerPill
                  id="decade"
                  neutral="Decade"
                  clearLabel="All decades"
                  options={decadeOptions}
                  value={mem.decade}
                  onChange={(decade) => setMem({ decade })}
                />
              </>
            }
            onChange={(genre) => setMem({ genre })}
          />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* the sort chip keeps its lone right spot */}
          <SortChip
            sorts={ALBUM_SORTS}
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
          className={cx(!cards && "divide-y divide-edge/50 -mx-2")}
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
          {shown.map((node) =>
            cards ? (
              <ContainerCard
                key={nodeKey(node)}
                node={node}
                playing={actions.isPlayingAlbum(node)}
                menuOpen={actions.menuNodeId === node.id}
                favorited={actions.nodeFavorited(node)}
                badge={multiServer ? node.serverName : undefined}
                onHeart={() => actions.heartNode(node)}
                onEnter={() => actions.openAlbum(node)}
                onPlay={(el) => void actions.playContainer(node, el)}
                onMenu={(e) => actions.openMenu(node, e)}
              />
            ) : (
              <ContainerRow
                key={nodeKey(node)}
                node={node}
                playing={actions.isPlayingAlbum(node)}
                menuOpen={actions.menuNodeId === node.id}
                favorited={actions.nodeFavorited(node)}
                badge={multiServer ? node.serverName : undefined}
                onHeart={() => actions.heartNode(node)}
                onEnter={() => actions.openAlbum(node)}
                onMenu={(e) => actions.openMenu(node, e)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ artists

interface LensArtist {
  key: string;
  name: string;
  artUrl: string | null;
  albums: MediaNode[];
  tracks: MediaNode[];
}

/**
 * A lens artist is content identity, not a node — the ⋯ / right-click menu
 * and Info want one, so it is synthesized: the entity's server (or the first
 * album's/track's) is what Info sums their page from.
 */
function lensArtistNode(a: LensArtist): MediaNode {
  const from = a.albums[0] ?? a.tracks[0];
  return {
    id: `lens-artist:${a.key}`,
    parentId: null,
    title: a.name,
    upnpClass: "object.container.person.musicArtist",
    isContainer: true,
    artUrl: a.artUrl,
    artist: null,
    album: null,
    year: null,
    trackNumber: null,
    durationSecs: null,
    ...(from?.serverUdn ? { serverUdn: from.serverUdn, serverName: from.serverName } : {}),
  };
}

// Session memory: selections, the artist filter, and each column's scroll
// spot survive the round trip through an album leaf (and screen switches).
// The With-albums toggle lives in settings (view defaults persist,
// 2026-08-06); this is the session's workspace — spot, filter, scroll.
let artistsMem: {
  artist: string | null;
  album: string | null;
  filter: string;
  scroll: { artists: number; albums: number; tracks: number };
} = { artist: null, album: null, filter: "", scroll: { artists: 0, albums: 0, tracks: 0 } };

/**
 * The miller view (vibin's Artists screen, adapted): Artists | Albums |
 * Tracks columns; clicking columns 1–2 is SELECTION (columns to the right
 * repopulate in place), never navigation. Column 3 keeps the app-wide track
 * click contract: a bare click PLAYS (queue-aware) — there is deliberately
 * no "selected track" concept. Artist identity is content identity: entity
 * nodes and plain artist strings merge by normalized name, so servers
 * without person entities (the USB stick) still get real artist rows.
 */
export function ArtistsLens({
  pools,
  actions,
}: {
  pools: MediaIndexPools[];
  actions: LensActions;
}): React.JSX.Element {
  const [mem, setMemState] = useState(artistsMem);
  const setMem = (patch: Partial<typeof artistsMem>): void => {
    artistsMem = { ...artistsMem, ...patch };
    setMemState(artistsMem);
  };
  const albumsOnly = useStore((s) => s.settings.lensArtistsAlbumsOnly);
  const saveSettings = useStore((s) => s.saveSettings);

  const multiServer = useMemo(() => pools.filter((g) => g.albums.length > 0).length > 1, [pools]);

  const artists = useMemo(() => {
    const byKey = new Map<string, LensArtist>();
    const ensure = (name: string): LensArtist => {
      const key = lc(name);
      let a = byKey.get(key);
      if (!a) {
        a = { key, name: name.trim(), artUrl: null, albums: [], tracks: [] };
        byKey.set(key, a);
      }
      return a;
    };
    for (const g of pools) {
      for (const e of g.artists) {
        const a = ensure(e.title);
        a.artUrl ??= e.artUrl;
      }
      for (const alb of g.albums) if (alb.artist) ensure(alb.artist).albums.push(alb);
      // Every PERFORMER is an artist, and only performers — never the packed
      // "A; B" string. A featured singer gets a row with their one track;
      // the headliner keeps every track of the album (2026-08-15).
      for (const t of g.tracks) for (const name of trackArtists(t)) ensure(name).tracks.push(t);
    }
    return [...byKey.values()]
      .filter((a) => a.albums.length > 0 || a.tracks.length > 0)
      .map((a) => ({
        ...a,
        artUrl: a.artUrl ?? a.albums.find((x) => x.artUrl)?.artUrl ?? null,
        albums: [...a.albums].sort(
          (x, y) => (y.year ?? "").localeCompare(x.year ?? "") || x.title.localeCompare(y.title),
        ),
      }))
      .sort((a, b) => nameSortKey(a.name).localeCompare(nameSortKey(b.name)));
  }, [pools]);

  const baseArtists = useMemo(
    () => (albumsOnly ? artists.filter((a) => a.albums.length > 0) : artists),
    [artists, albumsOnly],
  );
  const shownArtists = useMemo(
    () =>
      mem.filter ? baseArtists.filter((a) => matchesFilter(mem.filter, [a.name])) : baseArtists,
    [baseArtists, mem.filter],
  );

  // Album tracks by content identity: same server + same album title.
  const tracksByAlbum = useMemo(() => {
    const m = new Map<string, MediaNode[]>();
    for (const g of pools) {
      for (const t of g.tracks) {
        if (!t.album) continue;
        const k = `${g.udn}|${lc(t.album)}`;
        const list = m.get(k);
        if (list) list.push(t);
        else m.set(k, [t]);
      }
    }
    for (const [k, list] of m) m.set(k, orderTracks(list)); // disc, then position — or the server's order when the numbers repeat
    return m;
  }, [pools]);

  // Resolve the selection against the FILTERED list: filtering the selected
  // artist out empties the albums/tracks columns rather than showing content
  // for a row that isn't on screen; clearing the filter brings it back.
  const selectedArtist = shownArtists.find((a) => a.key === mem.artist) ?? null;
  const selectedAlbum = selectedArtist?.albums.find((a) => nodeKey(a) === mem.album) ?? null;
  // Two EDITIONS of one album (same title, artist, year, server — a 16/44.1
  // and a 24/44.1 folder) are two album rows; when the selected artist has
  // such twins, a track belongs to the edition whose ART it shares (Asset
  // stamps tracks with their folder's cover). Only then — a lone album must
  // not lose tracks over a server that gives tracks their own art.
  const twinTitled =
    selectedAlbum != null &&
    (selectedArtist?.albums ?? []).filter(
      (a) => a.serverUdn === selectedAlbum.serverUdn && lc(a.title) === lc(selectedAlbum.title),
    ).length > 1;
  const albumTracks = selectedAlbum
    ? (tracksByAlbum.get(`${selectedAlbum.serverUdn}|${lc(selectedAlbum.title)}`) ?? []).filter(
        (t) =>
          // same-titled album on the same server by ANOTHER artist stays out —
          // judged by album artist / performers, so a featured track ("Daft
          // Punk; Julian Casablancas" on Daft Punk's album) stays IN.
          trackInAlbumOf(t, selectedAlbum.artist) &&
          (!twinTitled || sameArt(t.artUrl, selectedAlbum.artUrl)),
      )
    : null;
  // an artist with no albums shows their loose tracks directly (vibin rule)
  const looseTracks =
    selectedArtist && selectedArtist.albums.length === 0 ? selectedArtist.tracks : null;
  // headline format + per-row deviation notes, decided together so they agree
  const albumFmt = albumFormat(albumTracks ?? []);

  // A-Z fast travel: letter anchors in the artists column.
  const artistsColRef = useRef<HTMLDivElement | null>(null);
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  // When the filter reshapes the artist list, keep the selection in sight —
  // clearing "beatles" pops hundreds of rows back in ABOVE the selected one.
  // Skips the mount run (the saved column scroll is restoring then).
  const listSettled = useRef(false);
  useEffect(() => {
    if (!listSettled.current) {
      listSettled.current = true;
      return;
    }
    if (mem.artist && selectedRowRef.current) scrollToVisible(selectedRowRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownArtists]);
  const albumsColRef = useRef<HTMLDivElement | null>(null);
  const tracksColRef = useRef<HTMLDivElement | null>(null);
  // Restore each column's remembered spot once, after first paint.
  useEffect(() => {
    requestAnimationFrame(() => {
      artistsColRef.current?.scrollTo({ top: artistsMem.scroll.artists });
      albumsColRef.current?.scrollTo({ top: artistsMem.scroll.albums });
      tracksColRef.current?.scrollTo({ top: artistsMem.scroll.tracks });
    });
  }, []);
  const letterRefs = useRef(new Map<string, HTMLDivElement>());
  const letterOf = (name: string): string => {
    const c = nameSortKey(name)[0]?.toUpperCase() ?? "#";
    return c >= "A" && c <= "Z" ? c : "#";
  };
  const letters = useMemo(
    () => [...new Set(shownArtists.map((a) => letterOf(a.name)))],
    [shownArtists],
  );
  const jumpToLetter = (letter: string): void => {
    const el = letterRefs.current.get(letter);
    const col = artistsColRef.current;
    if (el && col) col.scrollTo({ top: el.offsetTop - col.offsetTop });
  };

  // Playing-artist highlight is content identity, like everything else.
  const playingArtistKey = actions.playingArtist ? lc(actions.playingArtist) : null;

  const colHeading = (label: string, detail?: string): React.JSX.Element => (
    <div className="shrink-0 pb-1.5 mb-1.5 border-b border-edge flex items-baseline gap-2">
      <span className="microlabel">{label}</span>
      {detail && <span className="font-mono text-[10.5px] text-faint tabular-nums">{detail}</span>}
    </div>
  );

  let lastLetter = "";
  return (
    <div data-lens-artists className="h-full min-h-0 flex flex-col">
      {/* the filter sits ABOVE the columns (left — over the artists column
          it scopes), so all three columns' headings and rows stay aligned */}
      <div className="shrink-0 pb-3 flex items-center gap-2">
        <FilterInput
          value={mem.filter}
          onChange={(filter) => setMem({ filter })}
          shown={shownArtists.length}
          total={artists.length}
        />
        <Chip
          state={albumsOnly ? "active" : "idle"}
          aria-pressed={albumsOnly}
          data-tip="Hide artists that only have loose tracks"
          data-lens-albums-only
          className="tip-bottom shrink-0"
          onClick={() => void saveSettings({ lensArtistsAlbumsOnly: !albumsOnly })}
        >
          With albums
        </Chip>
      </div>
      <div className="min-h-0 flex-1 flex gap-6">
        {/* Artists ------------------------------------------------------- */}
        {/* proportional columns: fixed widths starved the tracks column (and
          its titles) at normal window sizes — tracks gets the largest share */}
        <div className="w-[24%] min-w-[220px] max-w-[320px] shrink-0 min-h-0 flex flex-col">
          {colHeading(
            "Artists",
            mem.filter || albumsOnly
              ? `${shownArtists.length}/${artists.length}`
              : String(artists.length),
          )}
          <div className="min-h-0 flex-1 flex gap-1">
            <div
              ref={artistsColRef}
              onScroll={(e) => {
                artistsMem.scroll.artists = e.currentTarget.scrollTop;
              }}
              // px/py with matching negative margins: room INSIDE the scrollport
              // for the rings and the row-playing glow (box-shadows clip at the
              // padding box) without shifting the rows off the heading's edge
              className="relative min-h-0 flex-1 overflow-y-auto px-1.5 -mx-1.5 py-1 -my-1"
            >
              {shownArtists.map((a) => {
                const letter = letterOf(a.name);
                const anchor = letter !== lastLetter;
                lastLetter = letter;
                const selected = a.key === mem.artist;
                const playing = a.key === playingArtistKey;
                return (
                  <div
                    key={a.key}
                    ref={(el) => {
                      if (anchor && el) letterRefs.current.set(letter, el);
                      if (selected && el) selectedRowRef.current = el;
                    }}
                    data-artist-row={a.name}
                    onClick={() => setMem({ artist: selected ? null : a.key, album: null })}
                    // right-click = the ⋯ (the app-wide rule): the artist menu — the
                    // pivot and Info. A lens artist is content identity, not a
                    // node, so one is synthesized: the entity's server (or the first
                    // album's) is what Info sums their page from.
                    onContextMenu={(e) => {
                      e.preventDefault();
                      actions.openMenu(lensArtistNode(a), e);
                    }}
                    data-lens-artist-row
                    className={cx(
                      "group grid grid-cols-[44px_1fr_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 cursor-pointer transition-colors",
                      selected
                        ? "bg-raised/70 ring-1 ring-edge2"
                        : playing
                          ? "bg-gold/10"
                          : "hover:bg-veil",
                    )}
                  >
                    <MediaArt src={a.artUrl} kind="artist" />
                    <div className="min-w-0">
                      <div
                        className={cx("text-[13.5px] truncate", playing ? "text-gold" : "text-ink")}
                      >
                        {a.name}
                      </div>
                      <div className="text-[12px] text-dim truncate">
                        {a.albums.length > 0
                          ? `${a.albums.length} album${a.albums.length === 1 ? "" : "s"}`
                          : `${a.tracks.length} track${a.tracks.length === 1 ? "" : "s"}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {playing && <Eqbars />}
                      {/* the ⋯, hover-revealed like the album rows' — the same
                        artist menu the right-click opens */}
                      <button
                        aria-label="More actions"
                        data-lens-artist-menu
                        onClick={(e) => {
                          e.stopPropagation();
                          actions.openMenu(lensArtistNode(a), e);
                        }}
                        className={cx(
                          "p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all",
                          actions.menuNodeId === `lens-artist:${a.key}`
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100",
                        )}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* the A-Z rail: fast travel for a long first column */}
            <div
              data-az-rail
              className="shrink-0 flex flex-col items-center justify-center gap-px pl-0.5 select-none"
            >
              {letters.map((l) => (
                <button
                  key={l}
                  onClick={() => jumpToLetter(l)}
                  className="px-1 text-[9.5px] leading-[13px] font-mono text-faint hover:text-gold transition-colors"
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Albums -------------------------------------------------------- */}
        <div className="w-[28%] min-w-[250px] max-w-[400px] shrink-0 min-h-0 flex flex-col">
          {colHeading("Albums", selectedArtist ? String(selectedArtist.albums.length) : undefined)}
          <div
            ref={albumsColRef}
            onScroll={(e) => {
              artistsMem.scroll.albums = e.currentTarget.scrollTop;
            }}
            className="min-h-0 flex-1 overflow-y-auto px-1.5 -mx-1.5 py-1 -my-1"
            data-lens-albums-col
          >
            {!selectedArtist ? (
              <div className="text-[12.5px] text-faint pt-2 px-1">Pick an artist.</div>
            ) : selectedArtist.albums.length === 0 ? (
              <div className="text-[12.5px] text-faint pt-2 px-1">No albums</div>
            ) : (
              selectedArtist.albums.map((alb) => {
                const selected = nodeKey(alb) === mem.album;
                const playing = actions.isPlayingAlbum(alb);
                return (
                  <div
                    key={nodeKey(alb)}
                    data-lens-album-row={alb.title}
                    onClick={() => setMem({ album: selected ? null : nodeKey(alb) })}
                    className={cx(
                      "group grid grid-cols-[44px_1fr_auto_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 cursor-pointer transition-colors",
                      selected
                        ? "bg-raised/70 ring-1 ring-edge2"
                        : playing
                          ? "bg-gold/10"
                          : "hover:bg-veil",
                    )}
                  >
                    <MediaArt src={alb.artUrl} kind="album" />
                    <div className="min-w-0">
                      <div
                        className={cx(
                          "flex items-center gap-2 text-[13.5px]",
                          playing ? "text-gold" : "text-ink",
                        )}
                      >
                        {/* no position cell in this list, so the playing marker
                          rides inline before the title (the floating skin's
                          rule) — artist row and track row both carry one, and
                          the album between them answers WHICH album sounds */}
                        {playing && <Eqbars />}
                        <span className="truncate">{alb.title}</span>
                      </div>
                      <div className="flex items-center gap-1.5 min-w-0 text-[12px] text-dim">
                        {alb.year && <span>{alb.year}</span>}
                        {multiServer && alb.serverName && (
                          <span
                            data-card-badge={alb.serverName}
                            className="shrink-0 text-[9.5px] px-1.5 py-px rounded-full ring-1 ring-edge"
                          >
                            {alb.serverName}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      aria-label={`Open album ${alb.title}`}
                      data-tip="Open album"
                      data-lens-open-album={alb.title}
                      onClick={(e) => {
                        e.stopPropagation();
                        actions.openAlbum(alb);
                      }}
                      className={cx(
                        "tip-bottom p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all",
                        actions.menuNodeId === alb.id
                          ? "opacity-100"
                          : "opacity-0 group-hover:opacity-100",
                      )}
                    >
                      <ArrowUpRight size={14} />
                    </button>
                    {isAlbumClass(alb.upnpClass) ? (
                      <button
                        aria-label="More actions"
                        onClick={(e) => {
                          e.stopPropagation();
                          actions.openMenu(alb, e);
                        }}
                        className={cx(
                          "p-1.5 rounded-lg text-dim hover:text-ink hover:bg-veil2 transition-all",
                          actions.menuNodeId === alb.id
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100",
                        )}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Tracks -------------------------------------------------------- */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {colHeading(
            "Tracks",
            selectedAlbum
              ? [
                  String(albumTracks?.length ?? 0),
                  fmtTime((albumTracks ?? []).reduce((acc, t) => acc + (t.durationSecs ?? 0), 0)),
                  // the album's format at a glance (from the tracks' <res>);
                  // rows that differ from it carry their own note below
                  albumFmt.label,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : looseTracks
                ? String(looseTracks.length)
                : undefined,
          )}
          <div
            ref={tracksColRef}
            onScroll={(e) => {
              artistsMem.scroll.tracks = e.currentTarget.scrollTop;
            }}
            className="min-h-0 flex-1 overflow-y-auto px-1.5 -mx-1.5 py-1 -my-1"
            data-lens-tracks-col
          >
            {albumTracks || looseTracks ? (
              // Multi-disc albums get a quiet "Disc N" divider per disc — only
              // when the list actually spans discs (discGroups is one group
              // otherwise, and the divider never renders).
              discGroups(albumTracks ?? looseTracks ?? []).map((g, gi) => (
                <div key={g.disc ?? `d${gi}`}>
                  {g.disc != null && (
                    <div className="microlabel px-1 pt-3 pb-1" data-disc-divider>
                      Disc {g.disc}
                    </div>
                  )}
                  <div className="divide-y divide-edge/50">
                    {g.tracks.map((t) => (
                      <TrackRow
                        key={nodeKey(t)}
                        node={t}
                        note={albumTracks ? albumFmt.notes[albumTracks.indexOf(t)] : null}
                        // inside an album under its artist, guests read as "feat."
                        artistLabel={selectedAlbum ? performerLine(t, selectedAlbum.artist) : null}
                        showArt={looseTracks != null}
                        isCurrent={actions.isCurrentTrack(t)}
                        queued={actions.trackQueued(t)}
                        menuOpen={actions.menuNodeId === t.id}
                        favorited={actions.nodeFavorited(t)}
                        onHeart={() => actions.heartNode(t)}
                        onPlayNow={(el) => actions.playTrack(t, el)}
                        onMenu={(e) => actions.openMenu(t, e)}
                      />
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-[12.5px] text-faint pt-2 px-1">
                {selectedArtist ? "Pick an album." : ""}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
