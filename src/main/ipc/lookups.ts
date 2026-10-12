import { IPC } from "@shared/ipc";
import {
  trackArtists,
  type EmbeddedArtQuery,
  type LyricsQuery,
  type MediaIndexPools,
  type TrackInfoQuery,
} from "@shared/model";
import { connectedHost, deviceManager } from "../app/runtime";
import { getSettings } from "../data/persist";
import { fetchAlbumInfo } from "../lookups/albumInfo";
import { fetchArtDataUrl } from "../lookups/artFetch";
import { fetchArtistInfo, knownArtistImage } from "../lookups/artistInfo";
import { artThumbsStats, clearArtThumbs } from "../lookups/artThumbs";
import { fetchCoverArt } from "../lookups/coverArt";
import { clearLookupCaches, lookupCacheStats } from "../lookups/diskCache";
import { fetchDiscTracks } from "../lookups/discTracks";
import { embeddedArtFor } from "../lookups/embeddedArt";
import { fetchLyrics } from "../lookups/lyrics";
import { radioByTags, radioSearch, radioTop } from "../lookups/radioBrowser";
import { scrobbler } from "../lookups/scrobbler";
import { fetchTrackInfo } from "../lookups/trackInfo";
import * as mediaIndex from "../media/mediaIndex";
import { knownServerHost } from "../media/upnpBrowser";
import { demoHost } from "../servers/demoStreamer";
import { handle } from "../app/guard";

/** Internet lookups, each behind its own switch: lyrics, ListenBrainz, artist, album, disc and track context, cover art, radio directories, embedded and fetched pictures, and the lookup caches. (Split out of index.ts's registerIpc in the 0.11.0 sweep.) */
/**
 * An artist's cover when there is no photo (2026-10-11, a user: "the grey square with disc
 * image"; MinimServer shows a related album's picture by default): the first of their albums
 * with a picture, else the first of their tracks. One map per pools snapshot.
 */
interface ArtistEntry {
  cover: string | null;
  albums: number;
  tracks: number;
}
const artistsByPools = new WeakMap<MediaIndexPools[], Map<string, ArtistEntry>>();
/** Every artist the indexes know, by name: a cover and the counts, by the Artists lens's rules
 *  (an album by its artist, a track by every performer), so the artist page and the lens agree. */
function artistIndex(pools: MediaIndexPools[]): Map<string, ArtistEntry> {
  const known = artistsByPools.get(pools);
  if (known) return known;
  const map = new Map<string, ArtistEntry>();
  const entry = (name: string | null | undefined): ArtistEntry | null => {
    const key = name?.trim().toLowerCase();
    if (!key) return null;
    let e = map.get(key);
    if (!e) map.set(key, (e = { cover: null, albums: 0, tracks: 0 }));
    return e;
  };
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

export function registerLookupsIpc(): void {
  // the rows' and cards' artist pictures: never a lookup (MusicBrainz answers one request a
  // second), only what is known; a photo only with the artist lookups on
  handle(IPC.artistPictures, (_e, names: unknown) => {
    const want = Array.isArray(names)
      ? names.filter((n): n is string => typeof n === "string")
      : [];
    const out: Record<string, string | null> = {};
    if (want.length === 0) return out;
    const photos = getSettings().artistInfo;
    const artists = artistIndex(mediaIndex.pools());
    for (const n of want)
      out[n] =
        (photos ? knownArtistImage(n) : null) ?? artists.get(n.trim().toLowerCase())?.cover ?? null;
    return out;
  });
  // the artist page's facts line: the lens's counts, from the ready indexes
  handle(IPC.artistFacts, (_e, name: unknown) => {
    if (typeof name !== "string") return null;
    const e = artistIndex(mediaIndex.pools()).get(name.trim().toLowerCase());
    return e ? { albums: e.albums, tracks: e.tracks } : null;
  });
  // Belt-and-braces gate: the renderer only asks while the setting is on, but
  // "off = no requests, ever" should hold even if a stale renderer asks.
  handle(IPC.fetchLyrics, (_e, q: LyricsQuery, force?: boolean) =>
    getSettings().lyrics ? fetchLyrics(q, !!force) : null,
  );
  handle(IPC.lbValidate, () => scrobbler.validateToken());
  handle(IPC.fetchArtistInfo, (_e, artist: string, force?: boolean) =>
    getSettings().artistInfo ? fetchArtistInfo(artist, !!force) : null,
  );
  handle(IPC.fetchAlbumInfo, (_e, artist: string, album: string, force?: boolean) =>
    getSettings().artistInfo ? fetchAlbumInfo(artist, album, !!force, true) : null,
  );
  // a disc's track names ride the same switch as the other MusicBrainz lookups: off, the
  // Queue screen's disc view names tracks by number. The demo streamer's disc is fictional,
  // so while the demo is the streamer it answers for its own release
  handle(
    IPC.fetchDiscTracks,
    (_e, releaseId: string, count: number | null, secs: number | null) => {
      if (!getSettings().artistInfo) return null;
      const demo = demoHost();
      const conn = deviceManager.snapshot().connection;
      const fromDemo = demo != null && conn.phase === "connected" && conn.host === demo;
      return fetchDiscTracks(releaseId, count, secs, fromDemo ? `http://${demo}` : undefined);
    },
  );
  handle(IPC.fetchTrackInfo, (_e, query: TrackInfoQuery, force?: boolean) =>
    getSettings().artistInfo &&
    typeof query?.artist === "string" &&
    typeof query?.title === "string"
      ? fetchTrackInfo(query, !!force)
      : null,
  );
  handle(IPC.albumArt, (_e, artist: string, album: string) =>
    getSettings().albumArtLookup && typeof artist === "string" && typeof album === "string"
      ? fetchCoverArt(artist, album)
      : null,
  );
  handle(IPC.lookupCacheStats, () => lookupCacheStats());
  handle(IPC.clearLookupCaches, () => clearLookupCaches());
  handle(IPC.artThumbsStats, () => artThumbsStats());
  handle(IPC.clearArtThumbs, () => clearArtThumbs());
  handle(IPC.radioSearch, (_e, query: string) => radioSearch(query));
  handle(IPC.radioTop, () => radioTop());
  handle(IPC.radioByTags, (_e, tags: string[]) => radioByTags(tags));
  handle(IPC.embeddedArt, (_e, query: EmbeddedArtQuery) => embeddedArtFor(connectedHost(), query));
  handle(IPC.fetchArt, async (_e, url: string) => {
    // a private address only for the streamer or a media server the app knows (lookups/artFetch)
    const streamer = ((): string | null => {
      const h = connectedHost();
      try {
        return h ? new URL(`http://${h}`).hostname : null;
      } catch {
        return null;
      }
    })();
    try {
      return await fetchArtDataUrl(url, (host) => host === streamer || knownServerHost(host));
    } catch {
      return null;
    }
  });
}
