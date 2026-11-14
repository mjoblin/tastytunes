import { nameKey } from "@shared/keys";
import type { MediaIndexPools, MediaNode } from "@shared/model";

/**
 * AN ALBUM'S COVER FROM ANOTHER LIBRARY (0.16.0). The streamer's USB drive serves its pictures at
 * addresses it re-mints on every wake, so a drive index the heal could not move (its folders
 * changed) keeps covers that no longer load, while the same album on a media server keeps a
 * picture that does. When an album's own picture is missing or fails, the album and artist are
 * looked up across the ready indexes for a cover at a lasting address: never one on the
 * streamer's own address (`volatileHost`), which dies the same way. An album first, then any of
 * its tracks; null when no library holds a lasting one. Pure: the pools and the host are given.
 */
export function albumArtElsewhere(
  pools: readonly MediaIndexPools[],
  artist: string,
  album: string,
  volatileHost: string | null,
): string | null {
  const wantAlbum = nameKey(album);
  const wantArtist = nameKey(artist);
  if (!wantAlbum || !wantArtist) return null;
  const lasting = (url: string | null | undefined): url is string => {
    if (!url) return false;
    try {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
      return volatileHost == null || host !== volatileHost;
    } catch {
      return false;
    }
  };
  const byArtist = (n: Pick<MediaNode, "artist" | "albumArtist">): boolean =>
    nameKey(n.albumArtist) === wantArtist || nameKey(n.artist) === wantArtist;
  for (const g of pools)
    for (const a of g.albums)
      if (nameKey(a.title) === wantAlbum && byArtist(a) && lasting(a.artUrl)) return a.artUrl;
  for (const g of pools)
    for (const t of g.tracks)
      if (nameKey(t.album) === wantAlbum && byArtist(t) && lasting(t.artUrl)) return t.artUrl;
  return null;
}
