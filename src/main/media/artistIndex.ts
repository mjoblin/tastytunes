import { trackArtists, type MediaIndexPools } from "@shared/model";

/**
 * WHAT THE INDEXES KNOW OF AN ARTIST (0.11.0, artist pictures): their real server picture, a
 * cover (2026-10-11, a user: "the grey square with disc image"; MinimServer shows a related
 * album's picture by default: the first of their albums with a picture, else the first of their
 * tracks) and their counts by the Artists lens's rules. Pure, one map per pools snapshot, so
 * the rules are unit-tested (artistIndex.test.ts).
 */
export interface ArtistEntry {
  /** The server's own picture for the artist when it is a real one: not one of the indexed
   *  albums' covers (2026-10-11, his minitunes: 370 of 371 artists carried one of their own
   *  album covers as their picture, which hid the photo; the one left was a userart.jpg). */
  own: string | null;
  cover: string | null;
  albums: number;
  tracks: number;
}
const artistsByPools = new WeakMap<MediaIndexPools[], Map<string, ArtistEntry>>();
/** Every artist the indexes know, by name: a cover and the counts, by the Artists lens's rules
 *  (an album by its artist, a track by every performer), so the artist page and the lens agree. */
export function artistIndex(pools: MediaIndexPools[]): Map<string, ArtistEntry> {
  const known = artistsByPools.get(pools);
  if (known) return known;
  const map = new Map<string, ArtistEntry>();
  const entry = (name: string | null | undefined): ArtistEntry | null => {
    const key = name?.trim().toLowerCase();
    if (!key) return null;
    let e = map.get(key);
    if (!e) map.set(key, (e = { own: null, cover: null, albums: 0, tracks: 0 }));
    return e;
  };
  const albumArt = new Set<string>();
  for (const p of pools) for (const a of p.albums) if (a.artUrl) albumArt.add(a.artUrl);
  for (const p of pools)
    for (const a of p.artists) {
      const e = entry(a.title);
      if (e && a.artUrl && !albumArt.has(a.artUrl)) e.own ??= a.artUrl;
    }
  for (const p of pools)
    for (const a of p.albums) {
      const e = entry(a.artist);
      if (!e) continue;
      e.albums++;
      e.cover ??= a.artUrl;
    }
  for (const p of pools)
    for (const t of p.tracks)
      for (const n of trackArtists(t)) {
        const e = entry(n);
        if (!e) continue;
        e.tracks++;
        e.cover ??= t.artUrl;
      }
  artistsByPools.set(pools, map);
  return map;
}
