import { z } from "zod";
import {
  copyMarkOf,
  favoriteKey,
  heartOf,
  heartPeersFrom,
  type Favorite,
  LARGE_QUEUE_TRACKS,
  type PlaylistItem,
} from "@shared/model";
import { pools as indexPools } from "../../media/mediaIndex";
import { isRadioMetadata } from "@shared/smoip";
import { getSettings } from "../../data/persist";
import { radioSearch, radioByTags } from "../../lookups/radioBrowser";
import { LargeQueueError, refreshServers } from "../../media/upnpBrowser";
import { searchServer as librarySearch } from "../../media/mediaIndex";
import {
  type ToolContext,
  type ToolImpl,
  ok,
  err,
  kindOf,
  largeQueueAsk,
  freshObjectId,
  defineTool,
  localTimeOrNull,
  tracksArg,
  tracksOfRefs,
  trackOfRef,
  someTitles,
  rowIds,
} from "./toolkit";
import { nameKey } from "@shared/keys";

// The MCP bridge's collection tools (the collections: radio, playlists and their edits,
// favorites), one of six tool modules split out of mcpServer.ts 2026-09-13; the shapes and helpers
// they share live in ./toolkit.

export function collectionTools(ctx: ToolContext): Record<string, ToolImpl> {
  const { dm } = ctx;
  return {
    // ---- radio (keyless directory; never any listening telemetry)
    search_radio: defineTool({
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Station name or place. Optional when genre is given."),
        genre: z
          .string()
          .optional()
          .describe(
            "Style tag, e.g. 'jazz' — matched against the directory's tags, most-listened first.",
          ),
      },
      handler: async (a) => {
        // The directory gate lives at the source (radioBrowser.fetchRaw), so
        // with the setting off this tool would "work" and return [] — which
        // an agent reads as "no stations matched", not "lookups are off".
        // Humans get a disabled chip for this state; the agent gets told.
        if (getSettings().radioDirectory === false) {
          return err(
            "The internet-radio directory is turned off in Settings › Connections (Internet radio directory), so station lookups are unavailable. Favorited stations still play.",
          );
        }
        const q = a.query?.trim();
        const g = a.genre != null ? nameKey(a.genre) : undefined;
        if (!q && !g) return err("Pass query and/or genre.");
        let stations;
        if (g && !q) stations = await radioByTags([g]);
        else {
          stations = await radioSearch(q as string);
          if (g)
            stations = stations.filter((st) =>
              st.tags
                .toLowerCase()
                .split(",")
                .map((t) => t.trim())
                .includes(g),
            );
        }
        return ok(
          stations.slice(0, 15).map((st) => ({
            name: st.name,
            url: st.url,
            country: st.country,
            codec: st.codec,
            tags: st.tags,
          })),
        );
      },
    }),
    play_radio: defineTool({
      inputSchema: {
        url: z.string().url().describe("Stream URL (from search_radio or a station favorite)."),
        name: z.string().min(1).describe("Display name for the station."),
      },
      handler: async (a) => {
        ctx.connected();
        await dm.command({ type: "streamRadio", url: a.url, name: a.name });
        return ok(`Tuning to ${String(a.name)}.`);
      },
    }),
    // ---- favorites
    list_playlists: defineTool({
      handler: () => {
        const s = dm.snapshot();
        return ok(
          s.playlists.map((p) => ({
            id: p.id,
            name: p.name,
            tracks: p.items.length,
            seconds: p.items.reduce((n, i) => n + (i.durationSecs ?? 0), 0),
            last_played: localTimeOrNull(p.lastPlayedAt),
            // surfaced because a run that skipped tracks is worth knowing
            // about before you play it again
            missing_last_time: p.lastMissing ?? [],
          })),
        );
      },
    }),
    get_playlist: defineTool({
      inputSchema: { id: z.string().describe("Playlist id from list_playlists.") },
      handler: (a) => {
        const p = dm.snapshot().playlists.find((x) => x.id === a.id);
        if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
        // each row's place (edit_playlist's positions) and, when stored, its ids (0.16.0)
        return ok({
          id: p.id,
          name: p.name,
          items: p.items.map((i, position) => ({
            position,
            title: i.title,
            artist: i.artist,
            album: i.album,
            seconds: i.durationSecs ?? null,
            ...(i.serverUdn && i.objectId
              ? { server_udn: i.serverUdn, object_id: i.objectId }
              : {}),
          })),
        });
      },
    }),
    play_playlist: defineTool({
      inputSchema: { id: z.string().describe("Playlist id from list_playlists.") },
      handler: async (a) => {
        ctx.connected();
        const p = dm.snapshot().playlists.find((x) => x.id === a.id);
        if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
        if (p.items.length === 0) return err(`"${p.name}" is empty.`);
        const res = await dm.playlistActivate(a.id);
        const missed = res.missed.length;
        // Name a few and count the rest: a long playlist can miss dozens, and
        // twenty-two titles inline is noise an agent has to wade through.
        const sample = res.missed.slice(0, 3).join(", ");
        const more = res.missed.length - 3;
        return ok(
          missed > 0
            ? `Queued ${res.added} of ${res.total} from "${p.name}". ${missed} not found on any media server (${sample}${more > 0 ? `, +${more} more` : ""}).`
            : `Queued ${res.added} ${res.added === 1 ? "track" : "tracks"} from "${p.name}".`,
        );
      },
    }),
    create_playlist: defineTool({
      inputSchema: {
        name: z.string().describe("Name for the new playlist."),
        tracks: tracksArg(LARGE_QUEUE_TRACKS)
          .optional()
          .describe(
            `The tracks, in order (up to ${LARGE_QUEUE_TRACKS}): each {server_udn, object_id} from a listing or {title, artist?, album?}. Stored with their ids; the play queue is not touched.`,
          ),
        from_queue: z
          .boolean()
          .optional()
          .describe("Instead of tracks: seed it with the current play queue (default false)."),
      },
      handler: (a) => {
        if (a.tracks != null && a.from_queue === true)
          return err("Give tracks or from_queue, not both.");
        const s = dm.snapshot();
        // tracks named by the agent (0.16.0), found in the index and kept with their ids, so the
        // copy chosen is the copy played; the queue's entries carry no ids, so each is found in the
        // index by its content, and kept by content when it isn't there
        const fromQueue = (): PlaylistItem[] =>
          (s.queue?.items ?? [])
            .map((i) => i.metadata)
            .filter((m): m is NonNullable<typeof m> => m != null)
            .map(
              (m) =>
                (m.title
                  ? trackOfRef({
                      title: m.title,
                      artist: m.artist ?? undefined,
                      album: m.album ?? undefined,
                    })
                  : null) ?? {
                  title: m.title ?? "Unknown track",
                  artist: m.artist ?? null,
                  album: m.album ?? null,
                  artUrl: m.art_url ?? null,
                  serverUdn: null,
                  serverName: null,
                  objectId: null,
                  durationSecs: m.duration ?? null,
                },
            );
        const named = a.tracks != null ? tracksOfRefs(a.tracks) : null;
        if (named && named.items.length === 0)
          return err(
            `None of those is a track in the library index (${someTitles(named.missed)}). Use list_tracks or search_library for their ids.`,
          );
        const items = named ? named.items : a.from_queue === true ? fromQueue() : [];
        // The returned playlist, not a lookup by name: on a name collision
        // the stored name is uniquified, and finding by the REQUESTED name
        // would report the old playlist's id — an agent would then edit
        // the wrong list.
        const made = dm.collections.playlistCreate(a.name, items);
        const missed =
          named && named.missed.length > 0 ? ` Not found: ${someTitles(named.missed)}.` : "";
        return ok(
          `Created "${made.name}" with ${made.items.length} tracks. id: ${made.id}${missed}`,
        );
      },
    }),
    add_to_playlist: defineTool({
      inputSchema: {
        id: z.string().describe("Playlist id from list_playlists."),
        tracks: tracksArg(LARGE_QUEUE_TRACKS)
          .optional()
          .describe("Tracks to add at the end, in order. Default: the playing track."),
      },
      handler: (a) => {
        const s = dm.snapshot();
        const p = s.playlists.find((x) => x.id === a.id);
        if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
        if (a.tracks != null) {
          const { items, missed } = tracksOfRefs(a.tracks);
          if (items.length === 0)
            return err(
              `None of those is a track in the library index (${someTitles(missed)}). Use list_tracks or search_library for their ids.`,
            );
          dm.collections.playlistAppend(a.id, items);
          return ok(
            `Added ${items.length} ${items.length === 1 ? "track" : "tracks"} to "${p.name}".${missed.length > 0 ? ` Not found: ${someTitles(missed)}.` : ""}`,
          );
        }
        const md = s.playState?.metadata;
        // A playlist is an ordered list of TRACKS; a stream has no position
        // in one, and content identity needs a title and an artist.
        if (!md || isRadioMetadata(md)) return err("Nothing playing that can go in a playlist.");
        if (!md.title || !md.artist) return err("The playing track has no title/artist to store.");
        dm.collections.playlistAppend(a.id, [
          {
            title: md.title,
            artist: md.artist,
            album: md.album ?? null,
            artUrl: md.art_url ?? null,
            serverUdn: null,
            serverName: null,
            objectId: null,
            durationSecs: md.duration ?? null,
          },
        ]);
        return ok(`Added "${md.title}" to "${p.name}".`);
      },
    }),
    edit_playlist: defineTool({
      inputSchema: {
        id: z.string().describe("Playlist id from list_playlists."),
        rename: z.string().min(1).optional().describe("A new name."),
        remove_positions: z
          .array(z.number().int().min(0))
          .optional()
          .describe("Rows to take out, by position from get_playlist (0 = the first)."),
        move: z
          .strictObject({
            from: z.number().int().min(0).describe("The row's position now."),
            to: z.number().int().min(0).describe("Its position after the move."),
          })
          .optional()
          .describe("Move one row, after any removals (positions as they stand then)."),
      },
      // 0.16.0: an agent could not rename a playlist or take a track out of one
      handler: (a) => {
        const p = dm.snapshot().playlists.find((x) => x.id === a.id);
        if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
        if (a.rename == null && a.remove_positions == null && a.move == null)
          return err("Nothing to change: give rename, remove_positions or move.");
        const bad = (a.remove_positions ?? []).filter((i) => i >= p.items.length);
        if (bad.length > 0)
          return err(
            `"${p.name}" has ${p.items.length} rows (0 to ${p.items.length - 1}): no ${bad.join(", ")}.`,
          );
        const drop = new Set(a.remove_positions ?? []);
        const items = p.items.filter((_, i) => !drop.has(i));
        if (a.move != null) {
          const { from, to } = a.move;
          if (from >= items.length || to >= items.length)
            return err(
              `After the removals "${p.name}" has ${items.length} rows: move from and to are 0 to ${items.length - 1}.`,
            );
          const [row] = items.splice(from, 1);
          items.splice(to, 0, row);
        }
        const said: string[] = [];
        if (drop.size > 0 || a.move != null) {
          dm.collections.playlistSetItems(a.id, items);
          if (drop.size > 0)
            said.push(`took out ${drop.size} ${drop.size === 1 ? "track" : "tracks"}`);
          if (a.move != null) said.push(`moved row ${a.move.from} to ${a.move.to}`);
        }
        let name = p.name;
        if (a.rename != null) {
          const list = dm.collections.playlistRename(a.id, a.rename);
          name = list.find((x) => x.id === a.id)?.name ?? a.rename;
          said.push(`renamed it "${name}"`);
        }
        return ok(
          `"${name}": ${said.join(", ")}. ${items.length} ${items.length === 1 ? "track" : "tracks"}.`,
        );
      },
    }),
    delete_playlist: defineTool({
      inputSchema: { id: z.string().describe("Playlist id from list_playlists.") },
      handler: (a) => {
        const p = dm.snapshot().playlists.find((x) => x.id === a.id);
        if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
        dm.collections.playlistDelete(a.id);
        return ok(`Deleted "${p.name}".`);
      },
    }),
    list_favorites: defineTool({
      handler: () => {
        const s = dm.snapshot();
        const ids = rowIds();
        return ok(
          s.favorites.map((f) =>
            f.kind === "station"
              ? { key: favoriteKey(f), kind: f.kind, name: f.name, url: f.url }
              : {
                  key: favoriteKey(f),
                  kind: f.kind,
                  title: f.title,
                  artist: f.artist,
                  album: f.album,
                  // the copy's ids, as stored at heart time, else found by content (0.16.0)
                  ...(f.serverUdn && f.objectId
                    ? { server_udn: f.serverUdn, object_id: f.objectId }
                    : f.kind === "album"
                      ? ids.album(f.title, f.artist)
                      : ids.track(f)),
                },
          ),
        );
      },
    }),
    play_favorite: defineTool({
      inputSchema: {
        key: z.string().describe("Favorite key from list_favorites."),
        confirm_large: z
          .boolean()
          .optional()
          .describe(
            `Only after the user agreed: play an album favorite over ${LARGE_QUEUE_TRACKS} tracks anyway.`,
          ),
      },
      handler: async (a) => {
        const s = ctx.connected();
        const fav = s.favorites.find((f) => favoriteKey(f) === a.key);
        if (!fav) return err(`No favorite '${String(a.key)}'. Use list_favorites.`);
        if (fav.kind === "station") {
          await dm.command({ type: "streamRadio", url: fav.url, name: fav.name });
          return ok(`Tuning to ${fav.name}.`);
        }
        const host = s.connection.host;
        const confirm = { confirmLarge: a.confirm_large === true };
        await dm.ensureAwake(); // favorites are wake intents too
        if (fav.serverUdn && fav.objectId) {
          // a USB favorite's stored id may have rotted: the index revalidates first, and a
          // Browse-only server has no search to heal by below
          const fresh = await freshObjectId(host, fav.serverUdn, fav.objectId);
          try {
            await dm.queueAdd(
              fav.serverUdn,
              "id" in fresh ? fresh.id : fav.objectId,
              "PLAY_NOW",
              undefined,
              confirm,
            );
            return ok(`Playing ${fav.title}.`);
          } catch (e) {
            if (e instanceof LargeQueueError) return err(largeQueueAsk(e.tracks, "play_favorite"));
            // stored id went stale — heal by content below (the app's model:
            // object ids are hints, title/artist identity is the truth)
          }
        }
        for (const server of (await refreshServers(host)).filter((x) => x.searchable)) {
          const { items } = await librarySearch(host, server.udn, fav.title);
          const match = items.find(
            (n) =>
              kindOf(n) === fav.kind &&
              nameKey(n.title) === nameKey(fav.title) &&
              (fav.artist == null || n.artist == null || nameKey(n.artist) === nameKey(fav.artist)),
          );
          if (match) {
            try {
              await dm.queueAdd(server.udn, match.id, "PLAY_NOW", undefined, confirm);
            } catch (e) {
              if (e instanceof LargeQueueError)
                return err(largeQueueAsk(e.tracks, "play_favorite"));
              throw e;
            }
            dm.collections.favoriteUpdate(a.key, {
              serverUdn: server.udn,
              serverName: server.name,
              objectId: match.id,
            });
            return ok(`Playing ${fav.title} (found on ${server.name}).`);
          }
        }
        return err(`Couldn't find "${fav.title}" on any media server right now.`);
      },
    }),
    add_favorite: defineTool({
      inputSchema: {
        server_udn: z
          .string()
          .optional()
          .describe("With object_id: favorite a library album or track, from a listing."),
        object_id: z.string().optional().describe("The album's or track's id."),
        station_url: z.string().url().optional().describe("Favorite a station: its stream URL…"),
        station_name: z.string().optional().describe("…and its display name (both or neither)."),
      },
      handler: (a) => {
        // A LIBRARY ITEM BY REFERENCE (0.16.0): an album or a track from a listing, as the
        // Library's heart makes it (this copy's own, beside any other copy's); favorites are the
        // app's own, so no streamer is needed
        if (a.server_udn != null || a.object_id != null) {
          if (a.server_udn == null || a.object_id == null)
            return err("Pass both server_udn and object_id (from a listing).");
          const pool = indexPools().find((p) => p.udn === a.server_udn);
          const node =
            pool?.albums.find((n) => n.id === a.object_id) ??
            pool?.tracks.find((n) => n.id === a.object_id);
          if (!pool || !node)
            return err(
              `No album or track '${a.object_id}' in that server's index. Use list_albums or list_tracks.`,
            );
          const media: Favorite = {
            kind: node.isContainer ? "album" : "track",
            addedAt: Date.now(),
            title: node.title,
            artist: node.artist,
            album: node.isContainer ? null : node.album,
            artUrl: node.artUrl,
            serverUdn: pool.udn,
            serverName: pool.serverName,
            objectId: node.id,
            titlePath: node.titlePath ?? null,
            durationSecs: node.isContainer ? null : node.durationSecs,
            rate: node.format?.rate ?? null,
            bits: node.format?.bits ?? null,
          };
          const favorites = dm.snapshot().favorites;
          if (heartOf(media, favorites, heartPeersFrom(indexPools())(media)))
            return ok("Already a favorite.");
          media.copy = copyMarkOf(media, media.addedAt);
          dm.collections.favoriteAdd(media);
          return ok(`Favorited the ${media.kind} "${media.title}".`);
        }
        const s = ctx.connected();
        let fav: Favorite;
        if (a.station_url != null || a.station_name != null) {
          if (typeof a.station_url !== "string" || typeof a.station_name !== "string") {
            return err(
              "Pass BOTH station_url and station_name (or neither, to favorite the current track).",
            );
          }
          fav = {
            kind: "station",
            addedAt: Date.now(),
            name: a.station_name,
            url: a.station_url,
            favicon: null,
            radioBrowserUuid: null,
          };
        } else {
          const md = s.playState?.metadata;
          if (md?.station) {
            return err(
              "For radio, pass station_url + station_name — the stream URL isn't knowable from playback metadata.",
            );
          }
          if (!md?.title) return err("Nothing identifiable is playing.");
          fav = {
            kind: "track",
            addedAt: Date.now(),
            title: md.title,
            artist: md.artist ?? null,
            album: md.album ?? null,
            artUrl: md.art_url ?? null,
            serverUdn: null,
            serverName: null,
            objectId: null,
            titlePath: null,
            durationSecs: md.duration ?? null,
            rate: md.sample_rate ?? null,
            bits: md.bit_depth ?? null,
          };
          // a heart is per copy (0.13.0): the playing copy's, beside any other copy's
          if (heartOf(fav, s.favorites, heartPeersFrom(indexPools())(fav)))
            return ok("Already a favorite.");
          fav.copy = copyMarkOf(fav, fav.addedAt);
        }
        const key = favoriteKey(fav);
        if (s.favorites.some((f) => favoriteKey(f) === key)) return ok("Already a favorite.");
        dm.collections.favoriteAdd(fav);
        return ok(
          fav.kind === "station" ? `Favorited station ${fav.name}.` : `Favorited "${fav.title}".`,
        );
      },
    }),
    remove_favorite: defineTool({
      inputSchema: { key: z.string().describe("Favorite key from list_favorites.") },
      // favorites are the app's own: no streamer needed (0.16.0)
      handler: (a) => {
        const s = dm.snapshot();
        const fav = s.favorites.find((f) => favoriteKey(f) === a.key);
        if (!fav) return err(`No favorite with key '${String(a.key)}'. Use list_favorites.`);
        dm.collections.favoriteRemove(a.key);
        return ok(
          fav.kind === "station"
            ? `Removed station ${fav.name} from favorites.`
            : `Removed "${fav.title}" from favorites.`,
        );
      },
    }),
  };
}
