import {
  type AppSettings,
  isHiRes,
  LOSSLESS_CODECS,
  type MediaFormat,
  type MediaNode,
} from "@shared/model";
import { compareRecentlyAdded } from "@shared/recentlyAdded";

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
  /** A track's ⋯; `list` is the rows it sits in, so its Info steps through them. */
  openMenu(node: MediaNode, e: React.MouseEvent, list?: MediaNode[]): void;
  menuNodeId: string | null;
  heartNode(node: MediaNode): void;
  /** Batch hearts: silent per-item toggles behind ONE aggregate undo entry. */
  heartNodes(nodes: MediaNode[], allIn: boolean): void;
  /** Albums drag to the nav rail (2026-09-02): the ordered containers (a box
   *  set's volumes) and the title the chip shows; `noun` names a multi-album
   *  selection's cargo ("albums", 0.8.0) where the chip would otherwise say
   *  volumes. */
  dragAlbum(nodes: MediaNode[], e: React.PointerEvent, title: string, noun?: string): void;
  /** The album selection bar's Analyze audio: each album's own sweep, in order
   *  (album DRs need every track of the album, so a track sweep will not do). */
  analyzeAlbums(nodes: MediaNode[]): void;
  /** A node whose audio the app cannot read (the streamer's own server): the
   *  analysis verbs show disabled with USB_ANALYSIS_HINT instead of failing. */
  unreadable(node: MediaNode): boolean;
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
   *  album by content identity through the lens crumb, the artist's page. */
  goToAlbum?(track: MediaNode): void;
  goToArtist?(track: MediaNode): void;
  /** The Tracks lens's "what's shown" verbs behind its split button: a
   *  one-click auto-named save (the Queue's precedent), and the analysis
   *  sweep over the shown set. */
  saveAsPlaylist?(chosen: MediaNode[], name: string): void;
  analyzeTracks?(chosen: MediaNode[], label: string): void;
}

export const lc = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();
export const nodeKey = (n: MediaNode): string => `${n.serverUdn ?? ""}|${n.id}`;

/** One pill that opens a picker popover — for bounded facets (decades) that
 *  shouldn't spend a whole rail row. The chevron marks it as a picker, not a
 *  toggle chip; an active pick renders gold like any active chip. Clicking the
 *  active option still toggles it off, but a picker popover reads as
 *  "choose one" — the explicit clear row is the discoverable way back out. */
// ------------------------------------------------------------------- facets

/** Genres by count (raw tagger strings, case-normalized by key). No cap:
 *  the picker's popover scrolls, and capping OPTIONS would strand genres. */
export function genreOptionsOf(
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
export function decadeOptionsOf(
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
export function drOptionsOf(
  drs: ReadonlyArray<number | null>,
): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<number, number>();
  for (const d of drs) if (d != null && d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts.entries()]
    .map(([d, count]) => ({ value: String(d), label: `DR${d}`, count }))
    .sort((a, b) => Number(b.value) - Number(a.value));
}

/** THE TEMPO FACET'S BANDS (0.12.0, the third of the measured facts): twenty beats a minute
 *  each, under 80 and 180 and up at the ends, the way a runner or a DJ asks ("around 165").
 *  A track's band from its tempo as Info says it (above its floor); none without one. */
const TEMPO_BAND_FLOORS = [0, 80, 100, 120, 140, 160, 180];
export function tempoBandOf(bpm: number | null | undefined): string | null {
  if (bpm == null || bpm <= 0) return null;
  let band = 0;
  for (const floor of TEMPO_BAND_FLOORS) if (bpm >= floor) band = floor;
  return String(band);
}
export function tempoBandLabel(band: string): string {
  const lo = Number(band);
  if (lo === 0) return "Under 80 bpm";
  if (lo === 180) return "180 bpm and up";
  return `${lo}–${lo + 19} bpm`;
}
/** The bands the measured tracks fall in, slowest first, with their counts. Offered from the
 *  first measured track (the picker's min of 1). */
export function tempoOptionsOf(
  bpms: ReadonlyArray<number | null>,
): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const b of bpms) {
    const band = tempoBandOf(b);
    if (band != null) counts.set(band, (counts.get(band) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: tempoBandLabel(value), count }))
    .sort((a, b) => Number(a.value) - Number(b.value));
}

/** The Format facet's tags for one track: its codec, plus the two DERIVED
 *  qualities (user, 2026-09-02: "what's still lossy" in one click) — from the
 *  app's one home for each predicate (LOSSLESS_CODECS, isHiRes). */
export const LOSSLESS_TAG = "__lossless";
export const HIRES_TAG = "__hires";
export const FORMAT_LABEL: Record<string, string> = {
  [LOSSLESS_TAG]: "Lossless",
  [HIRES_TAG]: "Hi-res",
};
export function formatTags(f: MediaFormat | undefined | null): string[] {
  if (!f?.codec) return [];
  const tags = [f.codec];
  if (LOSSLESS_CODECS.has(f.codec)) tags.push(LOSSLESS_TAG);
  if (isHiRes({ bits: f.bits, rate: f.rate })) tags.push(HIRES_TAG);
  return tags;
}

/** The Format facet's options over a list of tags (one per item per tag):
 *  Lossless and Hi-res first — offered only when they would actually
 *  narrow (0 < count < total) — then the codecs present, most common first.
 *  Offered from two options on (the picker's default min): a one-format
 *  library needs no Format facet. */
export function formatOptionsOf(
  tags: ReadonlyArray<string>,
  total: number,
): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const derived = [LOSSLESS_TAG, HIRES_TAG]
    .map((value) => ({ value, label: FORMAT_LABEL[value], count: counts.get(value) ?? 0 }))
    .filter((o) => o.count > 0 && o.count < total);
  const codecs = [...counts.entries()]
    .filter(([value]) => !(value in FORMAT_LABEL))
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return [...derived, ...codecs];
}

export const decadeOf = (year: string | null | undefined): string | null =>
  year ? `${Math.floor(Number(year) / 10) * 10}s` : null;

// ------------------------------------------------------------------- albums

/** The sorts that read the listening record — offered only while it has stats. */
export const RECORD_SORTS = new Set<string>(["lastPlayed", "plays", "wholeListens"]);

export const PLAY_THESE_MAX = 50;

/** What an album's copy chip means, as its tip says it (the lens index's copyBadge: the library,
 *  then which copy it is, shown only when there is another copy; 0.13.0-rc.4, a user had to work
 *  out what "FLAC · 24/96" on one album was telling him). */
export const COPY_BADGE_TIP = "There's another copy of this album";

/**
 * WHICH COPY an album is among its copies on one server, for its chip (0.13.0-rc.4, his pick on
 * "Card details": the chip says where the copies DIFFER, never what they share; two copies of one
 * album on a drive both said the folder name they share, and pushed the artist off the line).
 * The first fact no other copy has: its format (left to the card's format line when the card
 * shows one), its folder's name when that is not the album's title, then the part of its folder
 * path the others don't share ("Music", "Rock › The Band"); else "Copy 2", its place among all
 * the copies in the pools' order, so a copy a fact names stands for its number ("FLAC · 24/96",
 * "Copy 2", "Copy 3"). `copies` holds the album itself.
 */
export function whichCopy(
  a: MediaNode,
  copies: readonly MediaNode[],
  formatOf: (n: MediaNode) => string | null,
  { formatShown = false }: { formatShown?: boolean } = {},
): string {
  const all = copies.includes(a) ? copies : [a, ...copies];
  const folderOf = (n: MediaNode): string | null => {
    const f = n.titlePath?.[n.titlePath.length - 1] ?? null;
    return f && lc(f) !== lc(n.title) ? f : null;
  };
  const facts = [...(formatShown ? [] : [formatOf]), folderOf, folderPlaces(all)];
  for (const fact of facts) {
    const mine = fact(a);
    if (mine && all.every((c) => c === a || lc(fact(c)) !== lc(mine))) return mine;
  }
  return `Copy ${all.indexOf(a) + 1}`;
}

/** Each copy's place on its server: the part of its folder path (the folders above its own) past
 *  the part every copy shares, or the folder just above its own when it has nothing past that;
 *  null without a path. */
function folderPlaces(copies: readonly MediaNode[]): (n: MediaNode) => string | null {
  const above = new Map(copies.map((c) => [c, c.titlePath ? c.titlePath.slice(0, -1) : null]));
  const walked = [...above.values()].filter((p): p is string[] => p != null);
  let shared = 0;
  while (
    walked.length > 0 &&
    walked.every((p) => shared < p.length && lc(p[shared]) === lc(walked[0][shared]))
  )
    shared++;
  return (n) => {
    const p = above.get(n);
    if (!p || p.length === 0) return null;
    const past = p.slice(shared);
    return past.length > 0 ? past.join(" › ") : p[p.length - 1];
  };
}

/**
 * THE ARTIST PAGE'S ALBUM ORDER (0.13.0-rc.4, a user's question: the page lists an artist's albums
 * newest first, and with the year cut off on each card he could not tell what the order was).
 * By year, newest first, ties by title (the lens index's own order); or by title. Reversed turns
 * the whole list, as the lenses' sorts do.
 */
export function orderArtistAlbums(
  albums: readonly MediaNode[],
  sort: AppSettings["artistPageSort"],
  reversed: boolean,
): MediaNode[] {
  const byTitle = (a: MediaNode, b: MediaNode): number => a.title.localeCompare(b.title);
  const byYear = (a: MediaNode, b: MediaNode): number => (b.year ?? "").localeCompare(a.year ?? "");
  const sorted = [...albums].sort((a, b) =>
    sort === "title" ? byTitle(a, b) || byYear(a, b) : byYear(a, b) || byTitle(a, b),
  );
  return reversed ? sorted.reverse() : sorted;
}

// ------------------------------------------------------------- the filter's scope

/** The one field the Tracks lens's filter may be held to; null searches them all. */
export type FilterScope = "title" | "artist" | "album";

/**
 * THE TRACKS FILTER'S FIELDS (0.13.0-rc.4, his picks on the decision page "Filter Scope": "search
 * in" inside the filter box, remembered for the session as the pickers are). A track's title,
 * artist, album and year, or the one field the scope names. The filter (matchesFilter over these)
 * and its menu's counts (filterScopeCounts) read this one rule.
 */
export const filterFields = (
  t: Pick<MediaNode, "title" | "artist" | "album" | "year">,
  scope: FilterScope | null,
): Array<string | null | undefined> =>
  scope === "title"
    ? [t.title]
    : scope === "artist"
      ? [t.artist]
      : scope === "album"
        ? [t.album]
        : [t.title, t.artist, t.album, t.year];

/** How many of these tracks the filter finds in each scope (all fields, then each one): the
 *  scope menu's counts. One pass, each field read once (matchesFilter's rule: every word of the
 *  filter somewhere in the fields). */
export function filterScopeCounts(
  tracks: readonly Pick<MediaNode, "title" | "artist" | "album" | "year">[],
  filter: string,
): Record<"all" | FilterScope, number> {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const counts = { all: 0, title: 0, artist: 0, album: 0 };
  const has = (text: string): boolean => words.every((w) => text.includes(w));
  for (const t of tracks) {
    const title = (t.title ?? "").toLowerCase();
    const artist = (t.artist ?? "").toLowerCase();
    const album = (t.album ?? "").toLowerCase();
    if (has(`${title} ${artist} ${album} ${(t.year ?? "").toLowerCase()}`)) counts.all++;
    if (has(title)) counts.title++;
    if (has(artist)) counts.artist++;
    if (has(album)) counts.album++;
  }
  return counts;
}

/**
 * THE ARTISTS LENS'S ORDERS (0.13.0 round 12, a sort as the other lenses have): by name, the
 * index's own order; the most played first; the newest arrival first, an artist ranked by their
 * newest album in the Recently added order (dated, then a server's list). An artist the order
 * knows nothing of (no plays, nothing dated or listed) follows in name order, and reversed turns
 * the whole list, as the Albums lens does. The input is in name order.
 */
export function orderArtists<A extends { albums: readonly MediaNode[] }>(
  artists: readonly A[],
  sort: AppSettings["lensArtistsSort"],
  reversed: boolean,
  playsOf: (a: A) => number,
): A[] {
  let out = [...artists];
  if (sort === "plays") {
    const plays = new Map(out.map((a) => [a, playsOf(a)]));
    out.sort((a, b) => (plays.get(b) ?? 0) - (plays.get(a) ?? 0));
  } else if (sort === "added") {
    const newest = new Map(
      out.map((a) => [
        a,
        a.albums
          .filter((x) => (x.addedAt ?? 0) > 0 || x.recentRank != null)
          .sort(compareRecentlyAdded)[0] ?? null,
      ]),
    );
    out.sort((a, b) => {
      const x = newest.get(a) ?? null;
      const y = newest.get(b) ?? null;
      if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1);
      const rank = (n: MediaNode): number => n.recentRank ?? Number.MAX_SAFE_INTEGER;
      return (y.addedAt ?? 0) - (x.addedAt ?? 0) || rank(x) - rank(y);
    });
  }
  if (reversed) out = out.reverse();
  return out;
}
