import { IPC } from "@shared/ipc";
import type { LyricsQuery, TrackInfoQuery, EmbeddedArtQuery } from "@shared/model";
import { connectedHost, deviceManager } from "../app/runtime";
import { getSettings } from "../data/persist";
import { fetchAlbumInfo } from "../lookups/albumInfo";
import { fetchArtDataUrl } from "../lookups/artFetch";
import { fetchArtistInfo } from "../lookups/artistInfo";
import { artThumbsStats, clearArtThumbs } from "../lookups/artThumbs";
import { fetchCoverArt } from "../lookups/coverArt";
import { clearLookupCaches, lookupCacheStats } from "../lookups/diskCache";
import { fetchDiscTracks } from "../lookups/discTracks";
import { embeddedArtFor } from "../lookups/embeddedArt";
import { fetchLyrics } from "../lookups/lyrics";
import { radioByTags, radioSearch, radioTop } from "../lookups/radioBrowser";
import { scrobbler } from "../lookups/scrobbler";
import { fetchTrackInfo } from "../lookups/trackInfo";
import { knownServerHost } from "../media/upnpBrowser";
import { demoHost } from "../servers/demoStreamer";
import { handle } from "../app/guard";

/** Internet lookups, each behind its own switch: lyrics, ListenBrainz, artist, album, disc and track context, cover art, radio directories, embedded and fetched pictures, and the lookup caches. (Split out of index.ts's registerIpc in the 0.11.0 sweep.) */
export function registerLookupsIpc(): void {
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
