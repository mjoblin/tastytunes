import { artistGroups, type MediaIndexPools } from "@shared/model";

/**
 * WHAT THE INDEXES KNOW OF AN ARTIST (0.11.0, artist pictures): their real server picture, a
 * cover (2026-10-11, a user: "the grey square with disc image"; MinimServer shows a related
 * album's picture by default: the first of their albums with a picture, else the first of their
 * tracks) and their counts. Read off the one grouping the Artists lens reads too
 * (shared/model artistGroups, 0.13.0-rc.3), so the rows, the artist page and the lens agree;
 * the rules are unit-tested here (artistIndex.test.ts) and there.
 */
export interface ArtistEntry {
  /** The server's own picture for the artist when it is a real one (ArtistGroup.own). */
  own: string | null;
  cover: string | null;
  albums: number;
  tracks: number;
}
const artistsByPools = new WeakMap<MediaIndexPools[], Map<string, ArtistEntry>>();
/** Every artist the indexes know, by name lowercased: their pictures and their counts. */
export function artistIndex(pools: MediaIndexPools[]): Map<string, ArtistEntry> {
  const known = artistsByPools.get(pools);
  if (known) return known;
  const map = new Map<string, ArtistEntry>();
  for (const [key, g] of artistGroups(pools))
    map.set(key, { own: g.own, cover: g.cover, albums: g.albums.length, tracks: g.tracks.length });
  artistsByPools.set(pools, map);
  return map;
}
