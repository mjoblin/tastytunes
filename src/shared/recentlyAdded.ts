// RECENTLY ADDED (0.13.0 round 9; a user's report, 2026-10-25: MinimServer's Recently Added stops at
// 1,000 tracks, so albums imported in a batch get forgotten). Two sources, one order. The app
// notes the day each album first appears in an index (main/data/albumArrivals), on every server
// and with no cap, from the day this shipped; before that, a media server's own list (Asset's New
// Albums, Recently Added on MinimServer, MiniDLNA, Gerbera, UMS and Plex, Latest on Emby and
// Jellyfin) gives the order, found by its name or chosen by the reader (main/media/recentList).
// The order: the albums the app dated, newest first; then the albums a server's list names, in
// its order; then the rest. Nothing claims a date it doesn't know. Pure, shared by main (which
// stamps the albums) and the renderer (the Library's shelf and the Albums lens's sort).

import type { MediaNode } from "./model/media";

const lc = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/** A server's own recently-added list, by its name: the names the surveyed servers use (and a
 *  few near them), with any brackets or punctuation around them set aside ("[Recently Added]"). */
const RECENT_LIST_NAMES = new Set([
  "recently added",
  "latest",
  "new albums",
  "newest",
  "newly added",
  "recent additions",
  "new additions",
  "new music",
]);

export function isRecentListTitle(title: string): boolean {
  return RECENT_LIST_NAMES.has(
    lc(title)
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
      .replace(/\s+/g, " "),
  );
}

/** Containers that may hold the list one level down (Emby, Jellyfin and MiniDLNA keep it under
 *  Music, UMS under its Media Library's Audio). */
export function mayHoldRecentList(title: string): boolean {
  return /^(music|audio|media library|my music)$/.test(lc(title));
}

/** A picture address's path, the part that names the picture (a server's host can change). */
export function artPath(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** An album as title and artist, which a server's list and its index agree on. */
export function looseAlbumKey(
  title: string | null | undefined,
  artist: string | null | undefined,
): string {
  return `${lc(title)}|${lc(artist)}`;
}

/**
 * An album's identity for its arrival: its title and artist, and its picture's address where the
 * server keeps addresses (two editions of one album are two arrivals, round 1's rule that each
 * copy is its own). The streamer's USB drive re-mints its picture addresses on every wake, so
 * there the title and artist alone.
 */
export function arrivalKey(
  album: Pick<MediaNode, "title" | "artist" | "albumArtist" | "artUrl">,
  stableArt: boolean,
): string {
  const loose = looseAlbumKey(album.title, album.albumArtist ?? album.artist);
  const art = stableArt ? artPath(album.artUrl) : "";
  return art ? `${loose}|${art}` : loose;
}

/** One entry of a server's list, as an album: its title and artist, and its picture's path. */
export interface RecentEntry {
  loose: string;
  art: string;
}

/**
 * A server's list as albums, in its order: album containers as they are; tracks (MiniDLNA's and
 * Gerbera's lists hold tracks) grouped into their albums where each first appears. At most `max`.
 */
export function recentEntriesOf(nodes: readonly MediaNode[], max = 500): RecentEntry[] {
  const out: RecentEntry[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const title = n.isContainer ? n.title : n.album;
    if (!title) continue;
    const loose = looseAlbumKey(title, n.albumArtist ?? n.artist);
    if (seen.has(loose)) continue;
    seen.add(loose);
    out.push({ loose, art: artPath(n.artUrl) });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Where each of a server's albums stands in its list (0 first), matched by title and artist; of
 * two editions the list names by title and artist, the one whose picture it shows, or both.
 */
export function recentRanks(
  albums: ReadonlyArray<Pick<MediaNode, "title" | "artist" | "albumArtist" | "artUrl">>,
  entries: readonly RecentEntry[],
): Map<number, number> {
  const byLoose = new Map<string, number[]>();
  albums.forEach((a, i) => {
    const k = looseAlbumKey(a.title, a.albumArtist ?? a.artist);
    const list = byLoose.get(k);
    if (list) list.push(i);
    else byLoose.set(k, [i]);
  });
  const ranks = new Map<number, number>();
  entries.forEach((e, rank) => {
    const found = byLoose.get(e.loose);
    if (!found) return;
    const same = e.art ? found.filter((i) => artPath(albums[i].artUrl) === e.art) : [];
    for (const i of same.length > 0 ? same : found) if (!ranks.has(i)) ranks.set(i, rank);
  });
  return ranks;
}

/** The order: dated albums newest first, then those a server's list ranks (two servers' lists
 *  side by side, rank by rank), then the rest by title. A sort comparator. */
export function compareRecentlyAdded(
  a: Pick<MediaNode, "title" | "addedAt" | "recentRank">,
  b: Pick<MediaNode, "title" | "addedAt" | "recentRank">,
): number {
  const at = (n: typeof a): number => n.addedAt ?? 0;
  const rank = (n: typeof a): number => n.recentRank ?? Infinity;
  return at(b) - at(a) || rank(a) - rank(b) || a.title.localeCompare(b.title);
}

/** The albums known to be recent, in the order: dated, then ranked by a server's list. */
export function recentlyAdded<T extends Pick<MediaNode, "title" | "addedAt" | "recentRank">>(
  albums: readonly T[],
): T[] {
  return albums
    .filter((a) => (a.addedAt ?? 0) > 0 || a.recentRank != null)
    .sort(compareRecentlyAdded);
}
