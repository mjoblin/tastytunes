import { isHiRes, LOSSLESS_CODECS, type MediaFormat, type MediaNode } from "@shared/model";

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
