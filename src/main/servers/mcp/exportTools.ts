import { readFileSync } from "node:fs";
import { z } from "zod";
import type { MediaIndexPools, MediaNode } from "@shared/model";
import {
  albumDrKey,
  albumTracksOf,
  audioAnalysisKey,
  creditNames,
  playKey,
  usbServer,
  type ListeningPlayEvent,
} from "@shared/model";
import { matchesQuery, mediaType, nameKey, searchFold } from "@shared/keys";
import { getSettings } from "../../data/persist";
import { getFavorites } from "../../data/favorites";
import { getPlaylists } from "../../data/playlists";
import { listeningRecord } from "../../data/listeningRecord";
import { choiceOf, pickedPath, resolveChoice } from "../../data/artistChoices";
import { pools as indexPools } from "../../media/mediaIndex";
import { audioRes, refreshServers } from "../../media/upnpBrowser";
import { albumDrMap, audioAnalysisGet } from "../../lookups/audioAnalysis";
import { artHostTrust, fetchPicture } from "../../lookups/artFetch";
import { cachedLyrics, fetchLyrics, lyricsKnown } from "../../lookups/lyrics";
import { cachedTrackInfo, fetchTrackInfo, trackInfoKnown } from "../../lookups/trackInfo";
import { albumInfoKnown, cachedAlbumInfo, fetchAlbumInfo } from "../../lookups/albumInfo";
import {
  cachedArtistInfoForCredit,
  fetchArtistImages,
  fetchArtistInfoForCredit,
  knownArtistImage,
  knowsArtist,
} from "../../lookups/artistInfo";
import { fetchCommonsPhotos } from "../../lookups/commons";
import { cachedReleaseArt, fetchReleaseArt } from "../../lookups/releaseArt";
import { fetchFanartPhotos } from "../../lookups/fanart";
import { loggedFetch } from "../../netlog";
import { exportRoot } from "../../app/exportsFolder";
import { COPY_STALL_MS } from "../../export/exportFolder";
import {
  exportAlbum,
  exportTrack,
  type ArtistPictureOffer,
  type ExportEnv,
  type ExportOptions,
  type ExportReply,
  type ExportTarget,
} from "../../export/exporter";
import type { Looked } from "../../export/trackRecord";
import { defineTool, err, localTime, ok, type ToolContext, type ToolImpl } from "./toolkit";

// The MCP bridge's EXPORT TOOLS (0.17.0, export for an agent): export_track and export_album, the
// opt-in Exports group. What is exported and how is main/export (the exporter, its records, its
// one writer); this file names the track or album the call means and hands the exporter the app's
// own lookups, each behind its Connections switch, and the folder the owner chose.

const PICTURE_MAX_BYTES = 16 * 1024 * 1024;
/** What a copied track's answer may be: audio, as a media server names it. */
const AUDIO_TYPE = /^(audio\/[\w.+-]+|application\/(x-)?(ogg|flac))$/;
const NO_ARTIST: Looked<never> = {
  kind: "cannot",
  why: "The track has no artist tag, so it can't be looked up.",
  remedy: "None from TastyTunes: the file's tags would need an artist.",
};

const OPTION_ARGS = {
  fill: z
    .boolean()
    .optional()
    .describe(
      "Also look up what is missing (lyrics, credits, notes, pictures), as Settings › Connections allows, and analyze the audio first when it hasn't been. Default false: only what is already known.",
    ),
  audio: z
    .enum(["link", "copy", "none"])
    .optional()
    .describe(
      "'link' (default): the track's address on the user's network. 'copy': the file itself in the folder. 'none'.",
    ),
  redact: z
    .boolean()
    .optional()
    .describe(
      "Leave out addresses on the user's network, server ids and the dates of plays, so the folder can be handed on. Default false.",
    ),
  plays: z
    .boolean()
    .optional()
    .describe("With redact off, also list every play with its date. Default false."),
};

function optionsOf(a: {
  fill?: boolean;
  audio?: "link" | "copy" | "none";
  redact?: boolean;
  plays?: boolean;
}): ExportOptions {
  return {
    fill: a.fill === true,
    audio: a.audio ?? "link",
    redact: a.redact === true,
    plays: a.plays === true,
  };
}

/** A lookup behind its switch: off, known (read from the cache alone, never asking anyone),
 *  asked under fill, or not asked. */
async function lookup<T>(
  on: boolean,
  fill: boolean,
  cached: () => T | null | undefined,
  ask: () => Promise<T | null | "unreachable">,
  settledAfter: () => boolean,
): Promise<Looked<T>> {
  if (!on) return { kind: "off" };
  const held = cached();
  if (held !== undefined) return held != null ? { kind: "found", value: held } : { kind: "none" };
  if (!fill) return { kind: "not_asked" };
  const got = await ask();
  if (got === "unreachable") return { kind: "unreachable" };
  if (got != null) return { kind: "found", value: got };
  // a null is LRCLIB's or MusicBrainz's settled none only when the cache now holds it
  return settledAfter() ? { kind: "none" } : { kind: "unreachable" };
}

function replyOf(r: ExportReply): ReturnType<typeof ok> {
  if (r.kind === "refused") return err(r.message);
  if (r.kind === "analyzing") return ok(r.message);
  return ok({
    folder: r.folder,
    files: r.files.map((f) => ({ path: f.path, bytes: f.bytes })),
    missing: r.missing,
    ...(r.left_out.length > 0 ? { left_out: r.left_out } : {}),
    note: "The folder is on the computer TastyTunes runs on. README.md in it explains every file and field.",
  });
}

export function exportTools(ctx: ToolContext): Record<string, ToolImpl> {
  const host = (): string | null => {
    try {
      return ctx.connected().connection.host;
    } catch {
      return null;
    }
  };

  const env: ExportEnv = {
    pools: () => indexPools(),
    analysis: (n) => audioAnalysisGet(audioAnalysisKey(n)),
    albumMeasured: (album) => albumDrMap()[albumDrKey(album)] ?? null,
    analysisPossible: async (udn) => {
      if (!getSettings().waveforms)
        return {
          ok: false,
          why: "Audio analysis is off: the user can turn it on in Settings › Appearance.",
        };
      const h = host();
      const server = h ? (await refreshServers(h)).find((x) => x.udn === udn) : null;
      if (server && usbServer(server))
        return {
          ok: false,
          why: "None: tracks on the streamer's own USB drive can't be read, so they can't be analyzed.",
        };
      return { ok: true };
    },
    startAnalysis: (serverUdn, albumId) => {
      if (!ctx.windowOpen())
        return { why: "Audio is analyzed in the TastyTunes window, which is closed." };
      ctx.sendCommand({ id: "analyzeAlbum", serverUdn, albumId });
      return { started: true };
    },
    lyrics: (n, fill) => {
      const q = {
        artist: n.artist ?? "",
        title: n.title,
        album: n.album,
        duration: n.durationSecs != null ? Math.round(n.durationSecs) : null,
      };
      if (getSettings().lyrics && !n.artist) return Promise.resolve(NO_ARTIST);
      return lookup(
        getSettings().lyrics,
        fill,
        () => cachedLyrics(q),
        () => fetchLyrics(q),
        () => lyricsKnown(q),
      );
    },
    credits: (n, fill) => {
      const q = {
        artist: n.artist ?? "",
        title: n.title,
        album: n.album,
        duration: n.durationSecs,
      };
      if (getSettings().artistInfo && !n.artist) return Promise.resolve(NO_ARTIST);
      return lookup(
        getSettings().artistInfo,
        fill,
        () => cachedTrackInfo(q),
        () => fetchTrackInfo(q),
        () => trackInfoKnown(q),
      );
    },
    albumNotes: (artist, album, fill) => {
      const lead = creditNames(artist)[0] ?? artist;
      return lookup(
        getSettings().artistInfo,
        fill,
        // the whole credit's, then (a settled miss) its lead name's, as the ask below goes
        () => {
          const whole = cachedAlbumInfo(artist, album);
          return whole !== null || lead === artist ? whole : cachedAlbumInfo(lead, album);
        },
        async () =>
          (await fetchAlbumInfo(artist, album, false, true)) ??
          (lead !== artist ? await fetchAlbumInfo(lead, album, false, true) : null),
        () => albumInfoKnown(artist, album),
      );
    },
    artistNotes: (artist, fill) =>
      lookup(
        getSettings().artistInfo,
        fill,
        () => cachedArtistInfoForCredit(artist),
        () => fetchArtistInfoForCredit(artist),
        () => knowsArtist(artist),
      ),
    // the archive is asked only with Missing album art on, as for a missing cover (the switch
    // that names it), and its release group comes from Liner notes' answer
    releaseArt: (group, tracks, fill) =>
      getSettings().artistInfo && !getSettings().albumArtLookup
        ? Promise.resolve({
            kind: "cannot",
            why: "Missing album art is switched off in Settings › Connections, so the Cover Art Archive isn't asked.",
            remedy:
              "Ask the user to turn on Missing album art in Settings › Connections, then export again with fill: true.",
          })
        : lookup(
            getSettings().artistInfo,
            fill,
            () => cachedReleaseArt(group, tracks),
            () => fetchReleaseArt(group, tracks),
            () => cachedReleaseArt(group, tracks) !== undefined,
          ),
    artistPictures: async (artist, fill) => {
      const offers: ArtistPictureOffer[] = [];
      const online = getSettings().artistInfo;
      const chosen = choiceOf(artist);
      if (chosen) {
        const kept =
          chosen.kind === "file"
            ? pickedPath(chosen.file)
            : chosen.copy
              ? pickedPath(chosen.copy)
              : null;
        const now = resolveChoice(artist, indexPools());
        const url = chosen.kind === "file" ? null : (now?.offered ?? null);
        const cover = chosen.kind === "cover";
        // the window's rule (ipc/lookups artistChoices): a picture from the web is fetched only
        // with the artist lookups on; a cover, a kept copy or a file either way
        offers.push({
          source: "chosen",
          url,
          file: kept,
          local: cover,
          fetch: cover || (online && fill),
        });
      }
      if (!online)
        return {
          offers,
          gap: {
            what: "the artist's pictures from Wikipedia, Wikimedia Commons and fanart.tv",
            why: "Liner notes is switched off in Settings › Connections.",
            remedy:
              "Ask the user to turn on Liner notes in Settings › Connections, then export again with fill: true.",
          },
        };
      if (!fill) {
        const known = knownArtistImage(artist);
        if (known) offers.push({ source: "wikipedia", url: known, fetch: false });
        return {
          offers,
          gap: {
            what: "the artist's pictures from Wikipedia, Wikimedia Commons and fanart.tv",
            why: "Not looked up: the export was made without fill. Any already known are listed by address.",
            remedy: "Export again with fill: true.",
          },
        };
      }
      // the large photos first (Commons, fanart.tv), the article's thumbnails after, so the
      // files kept are the ones worth having
      for (const o of await fetchCommonsPhotos(artist))
        offers.push({
          source: "commons",
          url: o.url,
          page: o.page,
          width: o.width,
          height: o.height,
          fetch: true,
        });
      for (const url of await fetchFanartPhotos(artist))
        offers.push({ source: "fanart.tv", url, fetch: true });
      for (const url of await fetchArtistImages(artist))
        offers.push({ source: "wikipedia", url, fetch: true });
      return { offers, gap: null };
    },
    listeningOn: () => getSettings().listeningRecord,
    plays: async () =>
      (await listeningRecord.readAll()).events.filter(
        (e): e is ListeningPlayEvent => e.kind === "play",
      ),
    favorites: () => getFavorites(),
    playlists: () => getPlaylists(),
    presets: () => {
      try {
        return (ctx.connected().presets?.presets ?? []).flatMap((p) =>
          p.id != null ? [{ id: p.id, name: p.name ?? "", artUrl: p.art_url ?? null }] : [],
        );
      } catch {
        return [];
      }
    },
    picture: async (url) => {
      const got = await fetchPicture(url, artHostTrust(host()), {
        maxBytes: PICTURE_MAX_BYTES,
        timeoutMs: 15_000,
        logged: true,
      });
      return got ? { bytes: new Uint8Array(got.bytes), type: got.type } : null;
    },
    readFile: (path) => {
      try {
        return new Uint8Array(readFileSync(path));
      } catch {
        return null;
      }
    },
    audioUrl: async (udn, id) => {
      const h = host();
      const res = h ? await audioRes(h, udn, id) : null;
      return res ? { url: res.url, serverHost: res.serverHost } : null;
    },
    // ONLY FROM THE MEDIA SERVER ITSELF, ONLY AUDIO: the address is whatever the server's answer
    // said, so a broken or hostile server on the network can't point a copy elsewhere (no
    // redirect off its host), nor make one of a page (an audio type only); the answer's headers
    // within the analysis read's stall time, and the body held to it by the copy
    audioBody: async (url, serverHost) => {
      const notGiven = { why: "The media server didn't hand over the file." };
      const abort = new AbortController();
      const headers = setTimeout(() => abort.abort(), COPY_STALL_MS);
      try {
        let at = url;
        for (let hop = 0; hop < 4; hop++) {
          const where = new URL(at);
          if (where.hostname !== serverHost || !/^https?:$/.test(where.protocol))
            return { why: "The track's address isn't on its media server, so it wasn't fetched." };
          const res = await loggedFetch("media-audio", at, {
            signal: abort.signal,
            redirect: "manual",
          });
          if (res.status >= 300 && res.status < 400) {
            const next = res.headers.get("location");
            if (!next) return notGiven;
            at = new URL(next, at).toString();
            continue;
          }
          if (!res.ok || !res.body) return notGiven;
          const type = mediaType(res.headers.get("content-type"));
          if (!AUDIO_TYPE.test(type)) {
            void res.body.cancel();
            return { why: `The media server sent ${type || "something unnamed"}, not audio.` };
          }
          const declared = Number(res.headers.get("content-length") ?? 0);
          return {
            body: res.body as ReadableStream<Uint8Array>,
            bytes: declared > 0 ? declared : null,
          };
        }
        return { why: "The media server sent the file round too many redirects." };
      } catch {
        return notGiven;
      } finally {
        clearTimeout(headers);
      }
    },
    localTime,
    now: () => new Date(),
    clock: () => Date.now(),
  };

  /** The track a call means: by its ids, by its title, or the one playing. */
  const trackTarget = (a: {
    server_udn?: string;
    object_id?: string;
    title?: string;
    artist?: string;
    album?: string;
  }): ExportTarget | { error: string } | { candidates: unknown[] } => {
    const pools = indexPools();
    const of = (n: MediaNode, p: MediaIndexPools): ExportTarget => ({
      node: n,
      serverUdn: p.udn,
      serverName: p.serverName,
    });
    if (a.server_udn != null || a.object_id != null) {
      if (a.server_udn == null || a.object_id == null)
        return { error: "Give server_udn and object_id together, from a listing." };
      const p = pools.find((x) => x.udn === a.server_udn);
      const n = p?.tracks.find((x) => x.id === a.object_id);
      return p && n
        ? of(n, p)
        : {
            error: `No track '${a.object_id}' in that server's index. Use list_tracks for its id.`,
          };
    }
    let want: { title: string; artist?: string | null; album?: string | null };
    if (a.title) want = { title: a.title, artist: a.artist, album: a.album };
    else {
      const md = ctx.dm.snapshot().playState?.metadata;
      if (!md?.title) return { error: "Nothing is playing and no track was named." };
      want = { title: md.title, artist: md.artist, album: md.album };
    }
    const playing = !a.title;
    const hits: ExportTarget[] = [];
    for (const p of pools)
      for (const n of p.tracks) {
        const same = playing
          ? playKey(n.title, n.artist, n.album) === playKey(want.title, want.artist, want.album)
          : searchFold(n.title) === searchFold(want.title) &&
            (!want.artist || matchesQuery(want.artist, [n.artist])) &&
            (!want.album || matchesQuery(want.album, [n.album]));
        if (same) hits.push(of(n, p));
      }
    if (hits.length === 0)
      return {
        error: playing
          ? "The playing track isn't in a library TastyTunes has indexed (a stream, the radio or AirPlay has no file to export). Name a library track instead."
          : `No indexed track titled "${a.title}". Use list_tracks or search_library.`,
      };
    // tracks of another album or length are candidates; copies of one track are one
    const distinct = new Map(hits.map((h) => [audioAnalysisKey(h.node), h]));
    if (!playing && distinct.size > 1)
      return {
        candidates: [...distinct.values()].slice(0, 10).map((h) => ({
          title: h.node.title,
          artist: h.node.artist,
          album: h.node.album,
          server_udn: h.serverUdn,
          object_id: h.node.id,
        })),
      };
    return hits[0];
  };

  /** The album a call means: by its ids, by its name, or the one playing. */
  const albumTarget = (a: {
    server_udn?: string;
    object_id?: string;
    album?: string;
    artist?: string;
  }): ExportTarget | { error: string } | { candidates: unknown[] } => {
    const pools = indexPools();
    if (a.server_udn != null || a.object_id != null) {
      if (a.server_udn == null || a.object_id == null)
        return { error: "Give server_udn and object_id together, from list_albums." };
      const p = pools.find((x) => x.udn === a.server_udn);
      const n = p?.albums.find((x) => x.id === a.object_id);
      return p && n
        ? { node: n, serverUdn: p.udn, serverName: p.serverName }
        : {
            error: `No album '${a.object_id}' in that server's index. Use list_albums for its id.`,
          };
    }
    const md = a.album ? null : ctx.dm.snapshot().playState?.metadata;
    const title = a.album ?? md?.album ?? null;
    const artist = a.artist ?? (a.album ? null : (md?.artist ?? null));
    if (!title) return { error: "Nothing is playing and no album was named." };
    const hits: ExportTarget[] = [];
    // THE PLAYING ALBUM is the one holding the playing track: a compilation's or a featured
    // credit's track artist is never within the album's artist
    if (md?.title)
      for (const p of pools)
        for (const n of p.albums)
          if (
            nameKey(n.title) === nameKey(title) &&
            albumTracksOf(n, p).some(
              (t) => playKey(t.title, t.artist, t.album) === playKey(md.title, md.artist, md.album),
            )
          )
            hits.push({ node: n, serverUdn: p.udn, serverName: p.serverName });
    if (hits.length === 0)
      for (const p of pools)
        for (const n of p.albums)
          if (nameKey(n.title) === nameKey(title) && (!artist || matchesQuery(artist, [n.artist])))
            hits.push({ node: n, serverUdn: p.udn, serverName: p.serverName });
    if (hits.length === 0)
      return { error: `No indexed album "${title}". Use list_albums or search_library.` };
    const distinct = new Map(
      hits.map((h) => [`${nameKey(h.node.title)}|${nameKey(h.node.artist)}`, h]),
    );
    if (distinct.size > 1)
      return {
        candidates: [...distinct.values()].slice(0, 10).map((h) => ({
          album: h.node.title,
          artist: h.node.artist,
          server_udn: h.serverUdn,
          object_id: h.node.id,
        })),
      };
    return hits[0];
  };

  const run = async (
    t: ExportTarget | { error: string } | { candidates: unknown[] },
    opts: ExportOptions,
    exporter: typeof exportTrack,
  ) => {
    if ("error" in t) return err(t.error);
    if ("candidates" in t)
      return ok({
        ambiguous: true,
        note: "Several match: call again with one's server_udn and object_id.",
        candidates: t.candidates,
      });
    const place = exportRoot();
    if ("why" in place) return err(place.why);
    try {
      return replyOf(await exporter(env, place.root, t, opts));
    } catch (e) {
      return err(`The export stopped: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    export_track: defineTool({
      inputSchema: {
        server_udn: z.string().optional().describe("With object_id: the track, from a listing."),
        object_id: z.string().optional().describe("The track's id."),
        title: z
          .string()
          .optional()
          .describe("A track title in the library; omit for the playing track."),
        artist: z.string().optional(),
        album: z.string().optional(),
        ...OPTION_ARGS,
      },
      handler: (a) => run(trackTarget(a), optionsOf(a), exportTrack),
    }),
    export_album: defineTool({
      inputSchema: {
        server_udn: z.string().optional().describe("With object_id: the album, from list_albums."),
        object_id: z.string().optional().describe("The album's id."),
        album: z
          .string()
          .optional()
          .describe("An album title in the library; omit for the playing album."),
        artist: z.string().optional(),
        ...OPTION_ARGS,
      },
      handler: (a) => run(albumTarget(a), optionsOf(a), exportAlbum),
    }),
  };
}
