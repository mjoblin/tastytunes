import { BrowserWindow } from "electron";
import { IPC } from "@shared/ipc";
import type {
  ArtistChoice,
  ChosenPicture,
  EmbeddedArtQuery,
  LyricsQuery,
  MediaIndexPools,
  TrackInfoQuery,
} from "@shared/model";
import { connectedHost, deviceManager } from "../app/runtime";
import { getSettings, newMcpToken } from "../data/persist";
import { encryptsHere, getSecret, secretHint, setSecret } from "../data/secrets";
import { fetchAlbumInfo } from "../lookups/albumInfo";
import { artHostTrust, fetchArtDataUrl } from "../lookups/artFetch";
import { localOnly } from "../lookups/fetchGuard";
import { serversListed } from "../media/upnpBrowser";
import {
  choiceKeys,
  isArtistChoice,
  pickPictureFile,
  resolveChoice,
  setChoice,
} from "../data/artistChoices";
import { fetchArtistImages, fetchArtistInfo, knownArtistImage } from "../lookups/artistInfo";
import { checkFanartKey, fetchFanartPhotos } from "../lookups/fanart";
import { keepChoiceCopy } from "../lookups/choiceCopies";
import { fetchCommonsPhotos, fetchWikimediaSizes, wikimediaFile } from "../lookups/commons";
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
import { nameKey } from "@shared/keys";

/** Internet lookups, each behind its own switch: lyrics, ListenBrainz, artist, album, disc and track context, cover art, radio directories, embedded and fetched pictures, and the lookup caches. (Split out of index.ts's registerIpc in the 0.11.0 sweep.) */

/** The images a window may choose for an artist: the article's, fanart.tv's and Commons'. A
 *  choice of anything else is refused (setArtistChoice). */
async function offeredImages(name: string): Promise<string[]> {
  return [
    ...(await fetchArtistImages(name)),
    ...(await fetchFanartPhotos(name)),
    ...(await fetchCommonsPhotos(name)).map((o) => o.url),
  ];
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
    const pools = mediaIndex.pools();
    const artists = artistIndex(pools);
    // the picture chosen for them, else the server's real picture, else the photo, else a cover
    // (a server picture that is an album's cover counts as a cover)
    for (const n of want) {
      const e = artists.get(nameKey(n));
      out[n] =
        chosenPicture(n, pools, photos) ??
        e?.own ??
        (photos ? knownArtistImage(n) : null) ??
        e?.cover ??
        null;
    }
    return out;
  });
  // THE CHOSEN PICTURES (0.13.0 round 7; data/artistChoices), every one in one answer: a window
  // holds them (lib/artistPictures), so the artist page draws its choice first and an artist's
  // menu anywhere knows whether to offer the reset; the chooser offers the article's images,
  // the artist's covers and a file. A picture from the web is drawn only with the artist lookups
  // on ("off = no requests, ever") until its copy is kept (0.14.0), so with them off the usual
  // picture shows and the choice waits; a copy, a cover or a file shows either way.
  handle(IPC.artistChoices, () => {
    const photos = getSettings().artistInfo;
    const pools = mediaIndex.pools();
    const artists = artistIndex(pools);
    const out: Record<string, ChosenPicture> = {};
    for (const k of choiceKeys()) {
      // a choice made before its copy was kept gets one, in the background (lookups/choiceCopies)
      void keepChoiceCopy(k, { pools, photos, streamer: connectedHost() });
      const c = chosen(k, pools, photos);
      // a reset brings back the server's own picture first, then the photo (artistPictures)
      if (c) out[k] = { ...c, photoAfter: photos && !artists.get(k)?.own && !!knownArtistImage(k) };
    }
    return out;
  });
  // the article's images with their sizes (0.14.0: each picture's size under it), and the
  // artist's Commons photos the article doesn't show (the same photo is offered once)
  handle(IPC.artistImages, async (_e, name: unknown) => {
    if (typeof name !== "string" || !name.trim() || !getSettings().artistInfo) return [];
    const urls = await fetchArtistImages(name);
    const sizes = await fetchWikimediaSizes(urls);
    return urls.map((url) => {
      const s = sizes.get(wikimediaFile(url));
      return {
        url,
        thumb: null,
        width: s?.width ?? null,
        height: s?.height ?? null,
        page: s?.page ?? null,
      };
    });
  });
  handle(IPC.artistCommons, async (_e, name: unknown) => {
    if (typeof name !== "string" || !name.trim() || !getSettings().artistInfo) return [];
    const shown = new Set((await fetchArtistImages(name)).map(wikimediaFile));
    return (await fetchCommonsPhotos(name)).filter((o) => !shown.has(wikimediaFile(o.url)));
  });
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
      if (!(await offeredImages(name)).includes(choice.url)) return false;
    }
    setChoice(name, choice);
    // the copy it draws from, kept in the background: the address draws until it is there
    void keepChoiceCopy(name, {
      pools: mediaIndex.pools(),
      photos: getSettings().artistInfo,
      streamer: connectedHost(),
    });
    return true;
  });
  // the artist page's facts line: the lens's counts, from the ready indexes
  handle(IPC.artistFacts, (_e, name: unknown) => {
    if (typeof name !== "string") return null;
    const e = artistIndex(mediaIndex.pools()).get(nameKey(name));
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
  handle(IPC.secretsStatus, async () => ({
    encrypted: await encryptsHere(),
    lbToken: await secretHint("lbToken"),
    mcpToken: await secretHint("mcpToken"),
    fanartKey: await secretHint("fanartKey"),
  }));
  // a personal fanart.tv key (0.13.0 round 11): checked with fanart.tv before it is kept; a key
  // it refuses is not kept, one it could not be asked about is (checked again in use)
  handle(IPC.setFanartKey, async (_e, key: unknown) => {
    if (key === null) {
      await setSecret("fanartKey", null);
      return "removed";
    }
    if (typeof key !== "string" || !key.trim()) return "refused";
    const verdict = await checkFanartKey(key.trim());
    if (verdict !== "refused") await setSecret("fanartKey", key.trim());
    return verdict;
  });
  handle(IPC.artistFanart, (_e, name: unknown) =>
    typeof name === "string" && name.trim() && getSettings().artistInfo
      ? fetchFanartPhotos(name)
      : [],
  );
  // a ListenBrainz token checked with ListenBrainz before it is kept, as a fanart.tv key is
  handle(IPC.setLbToken, async (_e, token: unknown) => {
    if (token === null) {
      await setSecret("lbToken", null);
      return { verdict: "removed", userName: null };
    }
    if (typeof token !== "string" || !token.trim()) return { verdict: "refused", userName: null };
    const got = await scrobbler.validateToken(token.trim());
    if (got && !got.valid) return { verdict: "refused", userName: null };
    await setSecret("lbToken", token.trim());
    return got
      ? { verdict: "works", userName: got.userName }
      : { verdict: "unreachable", userName: null };
  });
  handle(IPC.mcpTokenReveal, async () => (await getSecret("mcpToken")) ?? "");
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
    // a private address only for the streamer or a media server the app knows (lookups/artFetch);
    // one not known yet waits for the server listing in flight, however long it takes
    // (serversListed: the wash's first fetch came before the listing, 0.13.0-rc.5)
    try {
      if (unknownLocal(url, artHostTrust(connectedHost()))) await serversListed();
      return await fetchArtDataUrl(url, artHostTrust(connectedHost()));
    } catch {
      return null;
    }
  });
}

/** An artist's chosen picture as resolveChoice finds it, a picture from the web only with the
 *  lookups on or its copy kept (drawn from the copy, it asks nothing); null with no choice (or
 *  one waiting for the lookups). */
function chosen(
  name: string,
  pools: MediaIndexPools[],
  photos: boolean,
): { kind: ArtistChoice["kind"]; url: string; offered: string } | null {
  const c = resolveChoice(name, pools);
  return c && (c.kind !== "image" || photos || c.url !== c.offered) ? c : null;
}

const chosenPicture = (name: string, pools: MediaIndexPools[], photos: boolean): string | null =>
  chosen(name, pools, photos)?.url ?? null;

/** A picture on a local address the app does not trust yet: its server may be in a listing
 *  still on its way (serversListed). */
function unknownLocal(raw: string, trusted: (hostname: string) => boolean): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
    return !trusted(host) && localOnly(host);
  } catch {
    return false;
  }
}
