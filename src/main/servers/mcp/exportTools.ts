import { readFileSync } from "node:fs";
import { z } from "zod";
import type { MediaIndexPools, MediaNode } from "@shared/model";
import {
  albumDrKey,
  audioAnalysisKey,
  creditNames,
  playKey,
  usbServer,
  type ListeningPlayEvent,
} from "@shared/model";
import { matchesQuery, nameKey, searchFold } from "@shared/keys";
import { getSettings } from "../../data/persist";
import { getFavorites } from "../../data/favorites";
import { getPlaylists } from "../../data/playlists";
import { listeningRecord } from "../../data/listeningRecord";
import { choiceOf, pickedPath, resolveChoice } from "../../data/artistChoices";
import { pools as indexPools } from "../../media/mediaIndex";
import { audioResUrl, refreshServers } from "../../media/upnpBrowser";
import { albumDrMap, audioAnalysisGet } from "../../lookups/audioAnalysis";
import { artHostTrust, fetchPicture } from "../../lookups/artFetch";
import { fetchLyrics, lyricsKnown } from "../../lookups/lyrics";
import { fetchTrackInfo, trackInfoKnown } from "../../lookups/trackInfo";
import { albumInfoKnown, fetchAlbumInfo } from "../../lookups/albumInfo";
import {
  fetchArtistImages,
  fetchArtistInfoForCredit,
  knownArtistImage,
  knowsArtist,
} from "../../lookups/artistInfo";
import { fetchCommonsPhotos } from "../../lookups/commons";
import { fetchFanartPhotos } from "../../lookups/fanart";
import { loggedFetch } from "../../netlog";
import { exportRoot } from "../../app/exportsFolder";
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

/** A lookup behind its switch: off, known, asked under fill, or not asked. */
async function lookup<T>(
  on: boolean,
  known: boolean,
  fill: boolean,
  ask: () => Promise<T | null | "unreachable">,
  settledAfter: () => boolean,
): Promise<Looked<T>> {
  if (!on) return { kind: "off" };
  if (!known && !fill) return { kind: "not_asked" };
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
    note: "README.md in the folder explains every file and field.",
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
      return lookup(
        getSettings().lyrics && !!n.artist,
        lyricsKnown(q),
        fill,
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
      return lookup(
        getSettings().artistInfo && !!n.artist,
        trackInfoKnown(q),
        fill,
        () => fetchTrackInfo(q),
        () => trackInfoKnown(q),
      );
    },
    albumNotes: (artist, album, fill) => {
      const lead = creditNames(artist)[0] ?? artist;
      return lookup(
        getSettings().artistInfo,
        albumInfoKnown(artist, album),
        fill,
        async () =>
          (await fetchAlbumInfo(artist, album, false, true)) ??
          (lead !== artist ? await fetchAlbumInfo(lead, album, false, true) : null),
        () => albumInfoKnown(artist, album),
      );
    },
    artistNotes: (artist, fill) =>
      lookup(
        getSettings().artistInfo,
        knowsArtist(artist),
        fill,
        () => fetchArtistInfoForCredit(artist),
        () => knowsArtist(artist),
      ),
    artistPictures: async (artist, fill) => {
      const offers: ArtistPictureOffer[] = [];
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
        offers.push({ source: "chosen", url, file: kept, local: chosen.kind === "cover" });
      }
      const online = getSettings().artistInfo;
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
        if (known) offers.push({ source: "wikipedia", url: known });
        return {
          offers,
          gap: {
            what: "the artist's pictures from Wikipedia, Wikimedia Commons and fanart.tv",
            why: "Not looked up: the export was made without fill. Any already known are listed by address.",
            remedy: "Export again with fill: true.",
          },
        };
      }
      for (const url of await fetchArtistImages(artist)) offers.push({ source: "wikipedia", url });
      for (const url of await fetchFanartPhotos(artist)) offers.push({ source: "fanart.tv", url });
      for (const o of await fetchCommonsPhotos(artist))
        offers.push({
          source: "commons",
          url: o.url,
          page: o.page,
          width: o.width,
          height: o.height,
        });
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
      return h ? audioResUrl(h, udn, id) : null;
    },
    audioBody: async (url) => {
      try {
        const res = await loggedFetch("media-audio", url, {});
        if (!res.ok || !res.body) return null;
        const declared = Number(res.headers.get("content-length") ?? 0);
        return {
          body: res.body as ReadableStream<Uint8Array>,
          bytes: declared > 0 ? declared : null,
        };
      } catch {
        return null;
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
