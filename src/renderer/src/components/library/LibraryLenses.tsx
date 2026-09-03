import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  Heart,
  ListEnd,
  ListPlus,
  ListStart,
  MoreHorizontal,
  Play,
  LayoutGrid,
  Rows3,
} from "lucide-react";
import {
  albumVolume,
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
  albumDrKey,
  audioAnalysisKey,
  trackPosition,
} from "@shared/model";
import { cx, fmtTime, matchesFilter, fmtCount } from "@/lib/format";
import { useStore } from "@/store";
import { tt } from "@/api";
import { FACT_SEP } from "@/lib/mediaFacts";
import { useAlbumDr } from "@/lib/audioAnalysis";
import { scrollToVisible } from "@/lib/scroll";
import { isAlbumClass } from "@/lib/media";
import { MediaArt } from "@/components/media/MediaArt";
import { FilterInput } from "@/components/controls/FilterInput";
import { PopoverChrome } from "@/hooks/usePopover";
import { POPOVER_CARD } from "@/components/chrome/Overlay";
import {
  Chip,
  HeaderChip,
  PrimaryButton,
  GAP_BETWEEN,
  GAP_WITHIN,
} from "@/components/chrome/Chrome";
import { SortChip } from "@/components/controls/SortChip";
import { Segmented } from "@/components/controls/Segmented";
import { ContainerCard, ContainerRow, TrackRow } from "@/components/library/LibraryCards";
import { RowMenu } from "@/components/media/RowMenu";
import { useNavDrag } from "@/hooks/useNavDrag";
import { flashNavTarget } from "@/lib/navDrop";
import { SelectionBar, SelectionVerb } from "@/components/controls/SelectionBar";
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
  /** Batch hearts: silent per-item toggles behind ONE aggregate undo entry. */
  heartNodes(nodes: MediaNode[], allIn: boolean): void;
  nodeFavorited(node: MediaNode): boolean;
  trackQueued(node: MediaNode): boolean;
  isCurrentTrack(node: MediaNode): boolean;
  isPlayingAlbum(node: MediaNode): boolean;
  /** The playing track's artist while the queue source is live — cheap
   *  content identity for the artists column (no per-render track scans). */
  playingArtist: string | null;
  /** The tracks column's selection bar: queue the batch (visible order —
   *  onDone fires only when the writes landed) and the batch-shaped playlist
   *  panel (onAdded fires when a target was picked, not on cancel). */
  queueTracks(
    chosen: MediaNode[],
    mode: "now" | "next" | "append" | "replace",
    onDone?: () => void,
  ): void;
  addTracksToPlaylist(
    chosen: MediaNode[],
    at: { x: number; y: number },
    onAdded?: () => void,
  ): void;
  /** The Tracks lens's second-line links (and its menu's Go-to verbs): the
   *  album by content identity through the lens crumb, the artist as the
   *  Artists lens focused on them. */
  goToAlbum?(track: MediaNode): void;
  goToArtist?(track: MediaNode): void;
  /** The Tracks lens's "what's shown" verbs behind its split button: a
   *  one-click auto-named save (the Queue's precedent), and the analysis
   *  sweep over the shown set. */
  saveAsPlaylist?(chosen: MediaNode[], name: string): void;
  analyzeTracks?(chosen: MediaNode[], label: string): void;
}

const lc = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();
const nodeKey = (n: MediaNode): string => `${n.serverUdn ?? ""}|${n.id}`;

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
  min,
}: {
  id: string;
  neutral: string;
  clearLabel: string;
  options: Array<{ value: string; label: string; count: number }>;
  value: string | null;
  onChange(value: string | null): void;
  /** Options needed before the pill shows (default 2 — a facet that can't
   *  distinguish is furniture; DR passes 1: one known value still filters
   *  the analyzed from the rest). */
  min?: number;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (options.length < (min ?? 2)) return null;
  const active = value ? options.find((o) => o.value === value) : null;
  return (
    <div className="relative">
      <Chip
        state={active ? "active" : open ? "open" : "idle"}
        data-lens-picker={id}
        onClick={() => setOpen((o) => !o)}
        className="no-drag gap-1 motion-safe:active:scale-95"
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
              "absolute left-0 top-full mt-1.5 z-30 w-56 max-h-72 overflow-y-auto",
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

// ------------------------------------------------------------------- facets

/** Genres by count (raw tagger strings, case-normalized by key). No cap:
 *  the picker's popover scrolls, and capping OPTIONS would strand genres. */
function genreOptionsOf(
  nodes: ReadonlyArray<Pick<MediaNode, "genre">>,
): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<string, { label: string; count: number }>();
  for (const n of nodes) {
    for (const g of n.genre ?? []) {
      const k = lc(g);
      const cur = counts.get(k);
      if (cur) cur.count++;
      else counts.set(k, { label: g, count: 1 });
    }
  }
  return [...counts.entries()]
    .map(([value, x]) => ({ value, ...x }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Decades from dc:date years, newest first. */
function decadeOptionsOf(
  nodes: ReadonlyArray<Pick<MediaNode, "year">>,
): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (!n.year) continue;
    const d = `${Math.floor(Number(n.year) / 10) * 10}s`;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => b.value.localeCompare(a.value));
}

/** Distinct recorded DR values, highest first — "show me all my DR13s".
 *  Offered from the first known value (the picker's min of 1). */
function drOptionsOf(
  drs: ReadonlyArray<number | null>,
): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<number, number>();
  for (const d of drs) if (d != null && d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts.entries()]
    .map(([d, count]) => ({ value: String(d), label: `DR${d}`, count }))
    .sort((a, b) => Number(b.value) - Number(a.value));
}

const decadeOf = (year: string | null | undefined): string | null =>
  year ? `${Math.floor(Number(year) / 10) * 10}s` : null;

// ------------------------------------------------------------------- albums

const ALBUM_SORTS: Array<{ value: "title" | "artist" | "year" | "dr"; label: string }> = [
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "year", label: "Year (newest first)" },
  { value: "dr", label: "Dynamic range" },
];

// Sort + direction live in settings (view defaults persist, 2026-08-06);
// what stays here is session workspace — filters, and the browse spot come
// back as they were left, and die with the app.
let albumsMem: {
  genre: string | null;
  decade: string | null;
  dr: string | null;
  filter: string;
} = { genre: null, decade: null, dr: null, filter: "" };

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
  const sort = useStore((s) => s.settings.lensAlbumsSort);
  const reversed = useStore((s) => s.settings.lensAlbumsSortReversed);
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
      return (
        a.title.localeCompare(b.title) || (a.serverName ?? "").localeCompare(b.serverName ?? "")
      );
    });
    return reversed ? sorted.reverse() : sorted;
  }, [all, mem, sort, reversed, kind, compilationKeys, albumDr]);

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
                id="dr"
                neutral="DR"
                clearLabel="Any DR"
                options={drOptions}
                value={mem.dr}
                onChange={(dr) => setMem({ dr })}
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
          {tiles.map(({ node: rawNode, set }) => {
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
                onHeart={() => actions.heartNode(rawNode)}
                onEnter={() => actions.openAlbum(rawNode)}
                onPlay={(el) => void actions.playContainer(rawNode, el)}
                onMenu={(e) => actions.openMenu(rawNode, e)}
              />
            ) : (
              <ContainerRow
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
                dr={albumDr[albumDrKey(node)]?.dr ?? null}
                onArtistLink={
                  actions.goToArtist && node.artist ? () => actions.goToArtist?.(node) : undefined
                }
                onHeart={() => actions.heartNode(rawNode)}
                onEnter={() => actions.openAlbum(rawNode)}
                onMenu={(e) => actions.openMenu(rawNode, e)}
              />
            );
          })}
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
  /** An artist to scroll into a comfortable spot on the next render (set by
   *  focusArtistsLens; consumed once). */
  reveal: string | null;
} = {
  artist: null,
  album: null,
  filter: "",
  scroll: { artists: 0, albums: 0, tracks: 0 },
  reveal: null,
};

/** Point the Artists lens at an artist before opening it — the Tracks and
 *  Albums lenses' artist links. Keys match the lens's own: the lowercased,
 *  trimmed name. The lens then REVEALS the row near the top of its column. */
export function focusArtistsLens(name: string): void {
  artistsMem = { ...artistsMem, artist: lc(name), album: null, reveal: lc(name) };
}

/** How far from the column's top a revealed artist lands — about a row and
 *  a half of context above it, so the eye reads where it is rather than
 *  finding the row pinned to the edge (user call, 2026-09-01). */
const REVEAL_PAD = 84;

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

  // Track-column multi-select — the queue/Library grammar on its third
  // surface. Keyed by nodeKey so twin editions stay distinct; cleared when
  // the artist or album selection moves, and by Esc (the app-wide release).
  const [selT, setSelT] = useState<ReadonlySet<string>>(() => new Set());
  const selTAnchor = useRef<number | null>(null);
  const visibleTracks = useMemo(() => albumTracks ?? looseTracks ?? [], [albumTracks, looseTracks]);
  useEffect(() => {
    setSelT(new Set());
    selTAnchor.current = null;
  }, [mem.artist, mem.album]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target;
      if (t instanceof HTMLElement && t.matches("input, textarea, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        if (visibleTracks.length === 0) return;
        e.preventDefault();
        setSelT(new Set(visibleTracks.map(nodeKey)));
        return;
      }
      if (selT.size === 0) return;
      if (e.key === "Escape") setSelT(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleTracks, selT.size]);
  // nav-rail blank clicks clear too (the queue's rule)
  useEffect(() => {
    if (selT.size === 0) return;
    const onWin = (e: MouseEvent): void => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (!t.closest("[data-app-nav], [data-app-playbar]")) return;
      if (t.closest("button, input, a, [aria-valuenow]")) return;
      setSelT(new Set());
    };
    window.addEventListener("click", onWin);
    return () => window.removeEventListener("click", onWin);
  }, [selT.size]);
  /** The plural ⋯: a menu invoked ON a selected track speaks for the whole
   *  selection (the Finder/Spotify convention); unselected rows keep the
   *  single-track builder menu via actions.openMenu. */
  const [lensMenu, setLensMenu] = useState<{ x: number; y: number } | null>(null);
  /** True = the click was a selection chord; the caller must not play. */
  const trackRowClick = (t: MediaNode, e: React.MouseEvent): boolean => {
    const key = nodeKey(t);
    const idx = visibleTracks.findIndex((x) => nodeKey(x) === key);
    if (e.metaKey || e.ctrlKey) {
      setSelT((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      selTAnchor.current = idx;
      return true;
    }
    if (e.shiftKey && selTAnchor.current != null && idx >= 0) {
      const [a, b] = [Math.min(selTAnchor.current, idx), Math.max(selTAnchor.current, idx)];
      setSelT(new Set(visibleTracks.slice(a, b + 1).map(nodeKey)));
      return true;
    }
    // selection mode suspends playback (the queue's rule, one grammar):
    // the first bare click exits the selection, the next plays
    if (selT.size > 0) {
      setSelT(new Set());
      return true;
    }
    return false;
  };
  const chosenT = (): MediaNode[] => visibleTracks.filter((t) => selT.has(nodeKey(t)));

  // Drag-to-rail from the lens's track column — same targets and semantics
  // as the Library lists, routed through the actions the lens already has.
  const lensDragCargo = useRef<{ nodes: MediaNode[]; fromSelection: boolean }>({
    nodes: [],
    fromSelection: false,
  });
  const lensNavDrag = useNavDrag({
    targets: ["queue", "playlists", "favorites"],
    payload: () => {
      const { nodes } = lensDragCargo.current;
      if (nodes.length === 0) return null;
      return { count: nodes.length, title: nodes[0].title };
    },
    onDrop: (target, at) => {
      const { nodes, fromSelection } = lensDragCargo.current;
      if (target === "queue") {
        actions.queueTracks(nodes, "append", () => {
          if (fromSelection) setSelT(new Set());
          flashNavTarget("queue");
        });
      } else if (target === "favorites") {
        actions.heartNodes(nodes, false);
        flashNavTarget("favorites");
      } else if (target === "playlists") {
        actions.addTracksToPlaylist(
          nodes,
          at,
          fromSelection ? () => setSelT(new Set()) : undefined,
        );
      }
    },
  });
  const startLensTrackDrag = (t: MediaNode, e: React.PointerEvent): void => {
    const fromSelection = selT.has(nodeKey(t));
    lensDragCargo.current = { nodes: fromSelection ? chosenT() : [t], fromSelection };
    lensNavDrag.start(e);
  };

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
    // a pending reveal (arrival by link) owns the column's first scroll
    if (artistsMem.reveal) return;
    if (mem.artist && selectedRowRef.current) scrollToVisible(selectedRowRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownArtists]);
  const albumsColRef = useRef<HTMLDivElement | null>(null);
  const tracksColRef = useRef<HTMLDivElement | null>(null);
  // Restore each column's remembered spot once, after first paint.
  useEffect(() => {
    requestAnimationFrame(() => {
      // the artists column defers to a pending reveal (below): under
      // StrictMode's double mount a second restore used to land AFTER the
      // reveal's frame and put the old scroll back (user, 2026-09-01: "same
      // as before" in the dev build while the built app passed)
      if (!artistsMem.reveal) artistsColRef.current?.scrollTo({ top: artistsMem.scroll.artists });
      albumsColRef.current?.scrollTo({ top: artistsMem.scroll.albums });
      tracksColRef.current?.scrollTo({ top: artistsMem.scroll.tracks });
    });
  }, []);
  // A focused artist (arrived by link) is revealed a comfortable way down
  // from the column's top, then the ask is consumed — a later visit keeps
  // the remembered scroll like any other. Container-scoped (never
  // scrollIntoView).
  useEffect(() => {
    const key = artistsMem.reveal;
    if (!key) return;
    const col = artistsColRef.current;
    const row = col?.querySelector<HTMLElement>(`[data-lens-artist-row="${CSS.escape(key)}"]`);
    if (!col || !row) return;
    requestAnimationFrame(() => {
      // consumed when APPLIED, not when scheduled — a repeated effect run
      // (StrictMode) schedules the same landing again, harmlessly
      if (artistsMem.reveal !== key) return;
      const top = Math.max(
        0,
        row.getBoundingClientRect().top -
          col.getBoundingClientRect().top +
          col.scrollTop -
          REVEAL_PAD,
      );
      col.scrollTo({ top });
      artistsMem.scroll.artists = top;
      artistsMem.reveal = null;
    });
  }, [shownArtists]);
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
    <div
      data-lens-artists
      className="h-full min-h-0 flex flex-col"
      onClick={(e) => {
        // blank-space click clears the selection (the Finder rule)
        if (selT.size === 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        const t = e.target as HTMLElement;
        // portaled dismiss clicks are their own gesture (the queue's rule)
        if (!e.currentTarget.contains(t)) return;
        if (
          t.closest(
            "button, input, a, [data-library-track], [data-lens-artist-row], [data-lens-album-row], [data-lens-selection-bar]",
          )
        )
          return;
        setSelT(new Set());
      }}
    >
      {/* the filter sits ABOVE the columns (left — over the artists column
          it scopes), so all three columns' headings and rows stay aligned */}
      <div className={`shrink-0 pb-3 flex items-center ${GAP_BETWEEN}`}>
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
                    data-lens-artist-row={a.key}
                    className={cx(
                      "group grid grid-cols-[44px_1fr_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 cursor-pointer transition-colors",
                      // SELECTED is "open here" — the Playlists sidebar's amber, so it
                      // reads apart from gold (= playing); a row that is both keeps
                      // the playing signals (gold title, eqbars) on the amber fill
                      // (user, 2026-09-02: the selection "didn't look distinctive").
                      // PLAYING is the app-wide row treatment — fill, ring and glow
                      // (row-playing), the same as ContainerRow and every track row —
                      // and it rides on top of the selection: a fill and an edge.
                      playing && "row-playing",
                      selected ? "bg-amberdim" : playing ? "bg-gold/10" : "hover:bg-veil",
                    )}
                  >
                    <MediaArt src={a.artUrl} kind="artist" />
                    <div className="min-w-0">
                      <div
                        className={cx(
                          "text-[13.5px] truncate",
                          playing ? "text-gold" : selected ? "text-amber" : "text-ink",
                        )}
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
                      // SELECTED is "open here" — the Playlists sidebar's amber, so it
                      // reads apart from gold (= playing); a row that is both keeps
                      // the playing signals (gold title, eqbars) on the amber fill
                      // (user, 2026-09-02: the selection "didn't look distinctive").
                      // PLAYING is the app-wide row treatment — fill, ring and glow
                      // (row-playing), the same as ContainerRow and every track row —
                      // and it rides on top of the selection: a fill and an edge.
                      playing && "row-playing",
                      selected ? "bg-amberdim" : playing ? "bg-gold/10" : "hover:bg-veil",
                    )}
                  >
                    <MediaArt src={alb.artUrl} kind="album" />
                    <div className="min-w-0">
                      <div
                        className={cx(
                          "flex items-center gap-2 text-[13.5px]",
                          playing ? "text-gold" : selected ? "text-amber" : "text-ink",
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
        <div className="relative flex-1 min-w-0 min-h-0 flex flex-col">
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
          {selT.size > 0 && (
            <SelectionBar
              count={selT.size}
              onClear={() => setSelT(new Set())}
              className="bottom-2 inset-x-0 z-20"
              data-lens-selection-bar
            >
              <SelectionVerb
                icon={<Play size={13} />}
                onClick={() => actions.queueTracks(chosenT(), "now", () => setSelT(new Set()))}
              >
                Play now
              </SelectionVerb>
              <SelectionVerb
                icon={<ListStart size={13} />}
                onClick={() => actions.queueTracks(chosenT(), "next", () => setSelT(new Set()))}
              >
                Play next
              </SelectionVerb>
              <SelectionVerb
                icon={<ListEnd size={13} />}
                onClick={() => actions.queueTracks(chosenT(), "append", () => setSelT(new Set()))}
              >
                Add to end of queue
              </SelectionVerb>
              <SelectionVerb
                icon={<ListPlus size={13} />}
                onClick={(e) =>
                  actions.addTracksToPlaylist(chosenT(), { x: e.clientX, y: e.clientY }, () =>
                    setSelT(new Set()),
                  )
                }
              >
                Add to playlist…
              </SelectionVerb>
              {(() => {
                const nodes = chosenT();
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
            </SelectionBar>
          )}
          <div
            ref={tracksColRef}
            onScroll={(e) => {
              artistsMem.scroll.tracks = e.currentTarget.scrollTop;
            }}
            className={cx(
              "min-h-0 flex-1 overflow-y-auto px-1.5 -mx-1.5 -my-1",
              // the floating bar overlaps the last rows at full scroll —
              // selection mode adds scroll-room so every row can clear it
              selT.size > 0 ? "pt-1 pb-24" : "py-1",
            )}
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
                    {g.tracks.map((t, ti) => (
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
                        selected={selT.has(nodeKey(t))}
                        selStart={!(ti > 0 && selT.has(nodeKey(g.tracks[ti - 1])))}
                        selEnd={!(ti < g.tracks.length - 1 && selT.has(nodeKey(g.tracks[ti + 1])))}
                        onRowClick={(e) => trackRowClick(t, e)}
                        onNavDrag={(e) => startLensTrackDrag(t, e)}
                        onHeart={() => actions.heartNode(t)}
                        onPlayNow={(el) => actions.playTrack(t, el)}
                        onMenu={(e) => {
                          if (selT.size > 1 && selT.has(nodeKey(t))) {
                            e.preventDefault();
                            e.stopPropagation();
                            setLensMenu({ x: e.clientX, y: e.clientY });
                          } else actions.openMenu(t, e);
                        }}
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
      {lensNavDrag.ghost}
      {lensMenu && (
        <RowMenu
          title={`${selT.size} tracks`}
          at={lensMenu}
          onClose={() => setLensMenu(null)}
          items={[
            {
              label: "Play now",
              run: () => actions.queueTracks(chosenT(), "now", () => setSelT(new Set())),
            },
            {
              label: "Play next",
              run: () => actions.queueTracks(chosenT(), "next", () => setSelT(new Set())),
            },
            {
              label: "Add to end of queue",
              run: () => actions.queueTracks(chosenT(), "append", () => setSelT(new Set())),
            },
            {
              label: "Add to playlist…",
              run: () => actions.addTracksToPlaylist(chosenT(), lensMenu, () => setSelT(new Set())),
            },
            (() => {
              const nodes = chosenT();
              const allIn = nodes.length > 0 && nodes.every(actions.nodeFavorited);
              return {
                label: allIn ? "Remove from favorites" : "Add to favorites",
                run: () => actions.heartNodes(nodes, allIn),
              };
            })(),
          ]}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- tracks

const TRACK_SORTS: Array<{
  value: "title" | "artist" | "album" | "year" | "duration" | "dr";
  label: string;
}> = [
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "album", label: "Album" },
  { value: "year", label: "Year (newest first)" },
  { value: "duration", label: "Duration (longest first)" },
  { value: "dr", label: "Dynamic range" },
];

/** "Play these N" appears once the list is NARROWED (a filter or a facet) —
 *  nobody means "replace the queue with 4,590 tracks" — and goes DISABLED
 *  above this many, with the reason in its tip: the verb replaces the queue,
 *  so the honest ceiling is a queue you would actually listen through, and
 *  queue writes are one call per track with no progress affordance, so
 *  fifty stays a few seconds where two hundred was a silent quarter minute
 *  (user call, 2026-09-01). */
const PLAY_THESE_MAX = 50;

// Sort + direction persist (view defaults); this is the session workspace —
// the filter, the facets and the scroll come back as they were left.
let tracksMem: {
  genre: string | null;
  decade: string | null;
  dr: string | null;
  filter: string;
  scroll: number;
} = { genre: null, decade: null, dr: null, filter: "", scroll: 0 };

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
 */
export function TracksLens({
  pools,
  actions,
}: {
  pools: MediaIndexPools[];
  actions: LensActions;
}): React.JSX.Element {
  const [mem, setMemState] = useState(tracksMem);
  const setMem = (patch: Partial<typeof tracksMem>): void => {
    tracksMem = { ...tracksMem, ...patch };
    setMemState(tracksMem);
  };
  const sort = useStore((s) => s.settings.lensTracksSort);
  const reversed = useStore((s) => s.settings.lensTracksSortReversed);
  const saveSettings = useStore((s) => s.saveSettings);

  const all = useMemo(() => pools.flatMap((g) => g.tracks), [pools]);
  const genreOptions = useMemo(() => genreOptionsOf(all), [all]);
  const decadeOptions = useMemo(() => decadeOptionsOf(all), [all]);

  // Per-track DR: one bulk cache-only read (never a fetch), refreshed each
  // time a sweep finishes — the DR sort has its numbers without asking the
  // server for anything.
  const waveformsOn = useStore((s) => s.settings.waveforms);
  const sweepIdle = useStore((s) => s.analysisProgress == null);
  const [drByKey, setDrByKey] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!waveformsOn || !sweepIdle || all.length === 0) return;
    let stale = false;
    void tt
      .audioDrMany(all.map((t) => audioAnalysisKey(t)))
      .then((m) => {
        if (!stale) setDrByKey(m);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [all, sweepIdle, waveformsOn]);
  const drOf = (t: MediaNode): number | null => drByKey[audioAnalysisKey(t)] ?? null;
  const drOptions = useMemo(
    () => drOptionsOf(all.map((t) => drByKey[audioAnalysisKey(t)] ?? null)),
    [all, drByKey],
  );

  const shown = useMemo(() => {
    let list = all;
    if (mem.genre) list = list.filter((t) => (t.genre ?? []).some((g) => lc(g) === mem.genre));
    if (mem.decade) list = list.filter((t) => decadeOf(t.year) === mem.decade);
    if (mem.dr) list = list.filter((t) => String(drOf(t) ?? "") === mem.dr);
    if (mem.filter)
      list = list.filter((t) => matchesFilter(mem.filter, [t.title, t.artist, t.album, t.year]));
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
      return byTitle(a, b);
    });
    return reversed ? sorted.reverse() : sorted;
    // drOf reads drByKey; listing it keeps the memo honest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, mem, sort, reversed, drByKey]);

  // WINDOWED LIST (2026-09-01, user: the cap read as a wall): render only
  // the rows near the viewport, so every sort over thousands of tracks stays
  // flat and nothing needs explaining. Rows are constant-height; the first
  // rendered one is measured, so the math never assumes a pixel. Selection,
  // ⌘A, shift-runs and drag operate on `shown` (the sorted list), never on
  // the rendered slice.
  const OVERSCAN = 8;
  const [rowH, setRowH] = useState(57);
  const [view, setView] = useState({ top: 0, height: 600 });
  const listRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = (): void =>
      setView((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const total = shown.length;
  const narrowed = Boolean(mem.filter || mem.genre || mem.decade || mem.dr);
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
      ? "Filter, or pick a decade, genre or DR, to play a set"
      : theseState === "over"
        ? `Narrow to ${fmtCount(PLAY_THESE_MAX)} tracks or fewer`
        : theseState === "empty"
          ? "Nothing matches those filters"
          : "Replaces the queue with these tracks";
  // what the narrowing IS, in words — the auto-named playlist and the
  // sweep's pulse both read it: '"love" · Rock · 2010s · DR13'
  const narrowing = [
    mem.filter ? `"${mem.filter.trim()}"` : null,
    mem.genre ? (genreOptions.find((g) => g.value === mem.genre)?.label ?? mem.genre) : null,
    mem.decade,
    mem.dr ? `DR${mem.dr}` : null,
  ]
    .filter(Boolean)
    .join(FACT_SEP);
  const [theseMenu, setTheseMenu] = useState<{ x: number; y: number } | null>(null);
  // measure once rows exist (and again if the list empties and refills)
  useEffect(() => {
    const h = probeRef.current?.offsetHeight ?? 0;
    if (h > 0 && h !== rowH) setRowH(h);
  }, [total, rowH]);
  const start = Math.max(0, Math.floor(view.top / rowH) - OVERSCAN);
  const end = Math.min(total, Math.ceil((view.top + view.height) / rowH) + OVERSCAN);
  const windowed = shown.slice(start, end);

  // ---- selection (the Artists lens's grammar, over the VISIBLE rows)
  const [selT, setSelT] = useState<ReadonlySet<string>>(() => new Set());
  const selTAnchor = useRef<number | null>(null);
  useEffect(() => {
    setSelT(new Set());
    selTAnchor.current = null;
  }, [mem.genre, mem.decade, mem.dr, mem.filter, sort, reversed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target;
      if (t instanceof HTMLElement && t.matches("input, textarea, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        if (shown.length === 0) return;
        e.preventDefault();
        setSelT(new Set(shown.map(nodeKey)));
        return;
      }
      if (selT.size === 0) return;
      if (e.key === "Escape") setSelT(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, selT.size]);
  const [lensMenu, setLensMenu] = useState<{ x: number; y: number } | null>(null);
  /** True = the click was a selection chord; the caller must not play. */
  const trackRowClick = (t: MediaNode, e: React.MouseEvent): boolean => {
    const key = nodeKey(t);
    const idx = shown.findIndex((x) => nodeKey(x) === key);
    if (e.metaKey || e.ctrlKey) {
      setSelT((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      selTAnchor.current = idx;
      return true;
    }
    if (e.shiftKey && selTAnchor.current != null && idx >= 0) {
      const [a, b] = [Math.min(selTAnchor.current, idx), Math.max(selTAnchor.current, idx)];
      setSelT(new Set(shown.slice(a, b + 1).map(nodeKey)));
      return true;
    }
    // selection mode suspends playback — a plain click releases it
    if (selT.size > 0) {
      setSelT(new Set());
      return true;
    }
    return false;
  };
  const chosenT = (): MediaNode[] => shown.filter((t) => selT.has(nodeKey(t)));

  // ---- drag-to-rail (the lens track grammar)
  const dragCargo = useRef<{ nodes: MediaNode[]; fromSelection: boolean }>({
    nodes: [],
    fromSelection: false,
  });
  const navDrag = useNavDrag({
    targets: ["queue", "playlists", "favorites"],
    payload: () => {
      const { nodes } = dragCargo.current;
      if (nodes.length === 0) return null;
      return { count: nodes.length, title: nodes[0].title };
    },
    onDrop: (target, at) => {
      const { nodes, fromSelection } = dragCargo.current;
      if (target === "queue") {
        actions.queueTracks(nodes, "append", () => {
          if (fromSelection) setSelT(new Set());
          flashNavTarget("queue");
        });
      } else if (target === "favorites") {
        actions.heartNodes(nodes, false);
        flashNavTarget("favorites");
      } else if (target === "playlists") {
        actions.addTracksToPlaylist(
          nodes,
          at,
          fromSelection ? () => setSelT(new Set()) : undefined,
        );
      }
    },
  });
  const startTrackDrag = (t: MediaNode, e: React.PointerEvent): void => {
    const fromSelection = selT.has(nodeKey(t));
    dragCargo.current = { nodes: fromSelection ? chosenT() : [t], fromSelection };
    navDrag.start(e);
  };

  // the list scrolls its own column; the spot survives a trip away
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
                id="dr"
                neutral="DR"
                clearLabel="Any DR"
                options={drOptions}
                value={mem.dr}
                onChange={(dr) => setMem({ dr })}
                min={1}
              />
            </div>
            {/* the narrowed list as the queue, in one gesture — the album
                Play button's semantics (replaces the queue) for what's shown */}
            {
              // a SPLIT button: the one-click primary, and a chevron opening
              // the rest of what a shown list can become — the selection
              // bar's verbs applied to what's shown, plus the two the bar
              // lacks (user call, 2026-09-01: "the shown list behaves like a
              // selection")
              <div
                className="flex items-center tip-bottom"
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
                  onClick={(e) => setTheseMenu({ x: e.clientX, y: e.clientY })}
                  className="no-drag flex items-center h-8 px-2 rounded-l-none border-l border-bg/25 shadow-none"
                >
                  <ChevronDown size={14} />
                </PrimaryButton>
              </div>
            }
          </div>
        </div>
        <div className={`flex items-center ${GAP_WITHIN} shrink-0`}>
          {/* the sort chip keeps its lone right spot */}
          <SortChip
            sorts={TRACK_SORTS}
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
          {selT.size > 0 && (
            <SelectionBar
              count={selT.size}
              onClear={() => setSelT(new Set())}
              className="bottom-2 inset-x-0 z-20"
              data-lens-selection-bar
            >
              <SelectionVerb
                icon={<Play size={13} />}
                onClick={() => actions.queueTracks(chosenT(), "now", () => setSelT(new Set()))}
              >
                Play now
              </SelectionVerb>
              <SelectionVerb
                icon={<ListStart size={13} />}
                onClick={() => actions.queueTracks(chosenT(), "next", () => setSelT(new Set()))}
              >
                Play next
              </SelectionVerb>
              <SelectionVerb
                icon={<ListEnd size={13} />}
                onClick={() => actions.queueTracks(chosenT(), "append", () => setSelT(new Set()))}
              >
                Add to end of queue
              </SelectionVerb>
              <SelectionVerb
                icon={<ListPlus size={13} />}
                onClick={(e) =>
                  actions.addTracksToPlaylist(chosenT(), { x: e.clientX, y: e.clientY }, () =>
                    setSelT(new Set()),
                  )
                }
              >
                Add to playlist…
              </SelectionVerb>
              {(() => {
                const nodes = chosenT();
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
            </SelectionBar>
          )}
          <div
            ref={listRef}
            onScroll={(e) => {
              const top = e.currentTarget.scrollTop;
              tracksMem.scroll = top;
              // snap to a row so a pixel of scroll never re-renders the slice
              const snapped = Math.floor(top / rowH) * rowH;
              setView((v) => (v.top === snapped ? v : { ...v, top: snapped }));
            }}
            className={cx(
              "min-h-0 flex-1 overflow-y-auto px-1.5 -mx-1.5 -my-1",
              selT.size > 0 ? "pt-1 pb-24" : "py-1",
            )}
            data-lens-tracks-list
          >
            <div style={{ height: total * rowH, position: "relative" }}>
              <div style={{ position: "absolute", top: start * rowH, left: 0, right: 0 }}>
                {windowed.map((t, i) => {
                  const idx = start + i;
                  return (
                    <div
                      key={nodeKey(t)}
                      ref={i === 0 ? probeRef : undefined}
                      className="border-b border-edge/50"
                    >
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
                        // the second line's links — the search-results
                        // treatment: the row plays, the names navigate
                        onAlbumLink={
                          actions.goToAlbum && t.album ? () => actions.goToAlbum?.(t) : undefined
                        }
                        onArtistLink={
                          actions.goToArtist && t.artist ? () => actions.goToArtist?.(t) : undefined
                        }
                        onRowClick={(e) => trackRowClick(t, e)}
                        onNavDrag={(e) => startTrackDrag(t, e)}
                        onHeart={() => actions.heartNode(t)}
                        onPlayNow={(el) => actions.playTrack(t, el)}
                        onMenu={(e) => {
                          if (selT.size > 1 && selT.has(nodeKey(t))) {
                            e.preventDefault();
                            e.stopPropagation();
                            setLensMenu({ x: e.clientX, y: e.clientY });
                          } else actions.openMenu(t, e);
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {lensMenu && (
            <RowMenu
              at={lensMenu}
              title={`${selT.size} tracks`}
              onClose={() => setLensMenu(null)}
              items={[
                {
                  label: "Play now",
                  run: () => actions.queueTracks(chosenT(), "now", () => setSelT(new Set())),
                },
                {
                  label: "Play next",
                  run: () => actions.queueTracks(chosenT(), "next", () => setSelT(new Set())),
                },
                {
                  label: "Add to end of queue",
                  run: () => actions.queueTracks(chosenT(), "append", () => setSelT(new Set())),
                },
                {
                  label: "Add to playlist…",
                  run: () =>
                    actions.addTracksToPlaylist(chosenT(), lensMenu, () => setSelT(new Set())),
                },
                (() => {
                  const nodes = chosenT();
                  const allIn = nodes.length > 0 && nodes.every(actions.nodeFavorited);
                  return {
                    label: allIn ? "Remove from favorites" : "Add to favorites",
                    run: () => actions.heartNodes(nodes, allIn),
                  };
                })(),
              ]}
            />
          )}
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
                    run: () => actions.analyzeTracks?.(shown, `${fmtCount(shown.length)} tracks`),
                  },
                ]
              : []),
          ]}
        />
      )}
      {navDrag.ghost}
    </div>
  );
}
