import { BrowserWindow } from "electron";
import { IPC } from "@shared/ipc";
import type {
  ArtistChoice,
  EmbeddedArtQuery,
  LyricsQuery,
  MediaIndexPools,
  TrackInfoQuery,
} from "@shared/model";
import { connectedHost, deviceManager } from "../app/runtime";
import { getSettings, newMcpToken } from "../data/persist";
import { canEncrypt, getSecret, secretHint, setSecret } from "../data/secrets";
import { fetchAlbumInfo } from "../lookups/albumInfo";
import { artHostTrust, fetchArtDataUrl } from "../lookups/artFetch";
import { isArtistChoice, pickPictureFile, resolveChoice, setChoice } from "../data/artistChoices";
import { fetchArtistImages, fetchArtistInfo, knownArtistImage } from "../lookups/artistInfo";
import { artThumbsStats, clearArtThumbs } from "../lookups/artThumbs";
import { fetchCoverArt } from "../lookups/coverArt";
import { clearLookupCaches, lookupCacheStats } from "../lookups/diskCache";
import { fetchDiscTracks } from "../lookups/discTracks";
import { embeddedArtFor } from "../lookups/embeddedArt";
import { fetchLyrics } from "../lookups/lyrics";
import { radioByTags, radioSearch, radioTop } from "../lookups/radioBrowser";
import { scrobbler } from "../lookups/scrobbler";
import { fetchTrackInfo } from "../lookups/trackInfo";
import { artistIndex } from "../media/artistIndex";
import * as mediaIndex from "../media/mediaIndex";
import { demoHost } from "../servers/demoStreamer";
import { handle } from "../app/guard";

/** Internet lookups, each behind its own switch: lyrics, ListenBrainz, artist, album, disc and track context, cover art, radio directories, embedded and fetched pictures, and the lookup caches. (Split out of index.ts's registerIpc in the 0.11.0 sweep.) */

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
    const pools = mediaIndex.pools();
    const artists = artistIndex(pools);
    // the picture chosen for them, else the server's real picture, else the photo, else a cover
    // (a server picture that is an album's cover counts as a cover)
    for (const n of want) {
      const e = artists.get(n.trim().toLowerCase());
      out[n] =
        chosenPicture(n, pools, photos) ??
        e?.own ??
        (photos ? knownArtistImage(n) : null) ??
        e?.cover ??
        null;
    }
    return out;
  });
  // THE CHOSEN PICTURE (0.13.0 round 7; data/artistChoices): the artist page reads it first, and
  // the chooser offers the article's images, the artist's covers and a file. A Wikipedia image
  // is drawn only with the artist lookups on ("off = no requests, ever"), so with them off the
  // usual picture shows and the choice waits; a cover or a file shows either way.
  handle(IPC.artistChoice, (_e, name: unknown) =>
    typeof name === "string" ? chosen(name, mediaIndex.pools(), getSettings().artistInfo) : null,
  );
  handle(IPC.artistImages, async (_e, name: unknown) =>
    typeof name === "string" && name.trim() && getSettings().artistInfo
      ? fetchArtistImages(name)
      : [],
  );
  handle(IPC.pickArtistPictureFile, (e) =>
    pickPictureFile(BrowserWindow.fromWebContents(e.sender)),
  );
  // a window chooses what the app offered: one of the article's images, an album's cover (found
  // again by its album later: resolveChoice), or a file the app copied in; false when it was not
  // one of those
  handle(IPC.setArtistChoice, async (_e, name: unknown, choice: unknown) => {
    if (typeof name !== "string" || !name.trim() || name.length > 500) return false;
    if (choice === null) {
      setChoice(name, null);
      return true;
    }
    if (!isArtistChoice(choice)) return false;
    if (choice.kind === "image") {
      if (!getSettings().artistInfo) return false;
      if (!(await fetchArtistImages(name)).includes(choice.url)) return false;
    }
    setChoice(name, choice);
    return true;
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
  // THE SECRETS STORE (0.13.0 round 10): a window learns only whether a token is saved and how it
  // ends; the MCP token itself goes to a window only for a Copy the person pressed
  handle(IPC.secretsStatus, () => ({
    encrypted: canEncrypt(),
    lbToken: secretHint("lbToken"),
    mcpToken: secretHint("mcpToken"),
  }));
  handle(IPC.setLbToken, (_e, token: unknown) => {
    if (token !== null && typeof token !== "string") return;
    setSecret("lbToken", token);
  });
  handle(IPC.mcpTokenReveal, () => getSecret("mcpToken") ?? "");
  handle(IPC.mcpTokenNew, () => newMcpToken());
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
    try {
      return await fetchArtDataUrl(url, artHostTrust(connectedHost()));
    } catch {
      return null;
    }
  });
}

/** An artist's chosen picture as resolveChoice finds it, a Wikipedia image only with the lookups
 *  on; null with no choice (or one waiting for the lookups). */
function chosen(
  name: string,
  pools: MediaIndexPools[],
  photos: boolean,
): { kind: ArtistChoice["kind"]; url: string } | null {
  const c = resolveChoice(name, pools);
  return c && (c.kind !== "image" || photos) ? c : null;
}

const chosenPicture = (name: string, pools: MediaIndexPools[], photos: boolean): string | null =>
  chosen(name, pools, photos)?.url ?? null;
