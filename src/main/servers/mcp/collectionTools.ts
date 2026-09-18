import { z } from "zod";
import { favoriteKey, type Favorite, LARGE_QUEUE_TRACKS } from "@shared/model";
import { isRadioMetadata } from "@shared/smoip";
import { getSettings } from "../../data/persist";
import { radioSearch, radioByTags } from "../../lookups/radioBrowser";
import { LargeQueueError, queueAdd, refreshServers } from "../../media/upnpBrowser";
import { searchServer as librarySearch } from "../../media/mediaIndex";
import {
  type ToolContext,
  type ToolImpl,
  ok,
  err,
  lc,
  kindOf,
  largeQueueAsk,
  freshObjectId,
} from "./toolkit";

// The MCP bridge's collection tools (the collections: radio, playlists and their edits,
// favorites), one of six tool modules split out of mcpServer.ts 2026-09-13; the shapes and helpers
// they share live in ./toolkit.

export function collectionTools(ctx: ToolContext): Record<string, ToolImpl> {
  const { dm } = ctx;
  return {
    // ---- radio (keyless directory; never any listening telemetry)
    search_radio: {
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
        const q = (a.query as string | undefined)?.trim();
        const g = (a.genre as string | undefined)?.trim().toLowerCase();
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
    },
    play_radio: {
      inputSchema: {
        url: z.string().url().describe("Stream URL (from search_radio or a station favorite)."),
        name: z.string().min(1).describe("Display name for the station."),
      },
      handler: async (a) => {
        ctx.connected();
        await dm.command({ type: "streamRadio", url: a.url as string, name: a.name as string });
        return ok(`Tuning to ${String(a.name)}.`);
      },
    },
    // ---- favorites
    list_playlists: {
      handler: () => {
        const s = dm.snapshot();
        return ok(
          s.playlists.map((p) => ({
            id: p.id,
            name: p.name,
            tracks: p.items.length,
            seconds: p.items.reduce((n, i) => n + (i.durationSecs ?? 0), 0),
            last_played: p.lastPlayedAt ?? null,
            // surfaced because a run that skipped tracks is worth knowing
            // about before you play it again
            missing_last_time: p.lastMissing ?? [],
          })),
        );
      },
    },
    get_playlist: {
      inputSchema: { id: z.string().describe("Playlist id from list_playlists.") },
      handler: (a) => {
        const p = dm.snapshot().playlists.find((x) => x.id === a.id);
        if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
        return ok({
          id: p.id,
          name: p.name,
          items: p.items.map((i) => ({
            title: i.title,
            artist: i.artist,
            album: i.album,
            seconds: i.durationSecs ?? null,
          })),
        });
      },
    },
    play_playlist: {
      inputSchema: { id: z.string().describe("Playlist id from list_playlists.") },
      handler: async (a) => {
        ctx.connected();
        const p = dm.snapshot().playlists.find((x) => x.id === a.id);
        if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
        if (p.items.length === 0) return err(`"${p.name}" is empty.`);
        const res = await dm.playlistActivate(a.id as string);
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
    },
    create_playlist: {
      inputSchema: {
        name: z.string().describe("Name for the new playlist."),
        from_queue: z
          .boolean()
          .optional()
          .describe("Seed it with the current play queue (default false — creates it empty)."),
      },
      handler: (a) => {
        const s = dm.snapshot();
        const items =
          a.from_queue === true
            ? (s.queue?.items ?? [])
                .map((i) => i.metadata)
                .filter((m): m is NonNullable<typeof m> => m != null)
                .map((m) => ({
                  title: m.title ?? "Unknown track",
                  artist: m.artist ?? null,
                  album: m.album ?? null,
                  artUrl: m.art_url ?? null,
                  serverUdn: null,
                  serverName: null,
                  objectId: null,
                  durationSecs: m.duration ?? null,
                }))
            : [];
        // The returned playlist, not a lookup by name: on a name collision
        // the stored name is uniquified, and finding by the REQUESTED name
        // would report the old playlist's id — an agent would then edit
        // the wrong list.
        const made = dm.playlistCreate(a.name as string, items);
        return ok(`Created "${made.name}" with ${made.items.length} tracks. id: ${made.id}`);
      },
    },
    add_to_playlist: {
      inputSchema: { id: z.string().describe("Playlist id from list_playlists.") },
      handler: (a) => {
        const s = dm.snapshot();
        const p = s.playlists.find((x) => x.id === a.id);
        if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
        const md = s.playState?.metadata;
        // A playlist is an ordered list of TRACKS; a stream has no position
        // in one, and content identity needs a title and an artist.
        if (!md || isRadioMetadata(md)) return err("Nothing playing that can go in a playlist.");
        if (!md.title || !md.artist) return err("The playing track has no title/artist to store.");
        dm.playlistAppend(a.id as string, [
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
    },
    delete_playlist: {
      inputSchema: { id: z.string().describe("Playlist id from list_playlists.") },
      handler: (a) => {
        const p = dm.snapshot().playlists.find((x) => x.id === a.id);
        if (!p) return err(`No playlist '${String(a.id)}'. Use list_playlists.`);
        dm.playlistDelete(a.id as string);
        return ok(`Deleted "${p.name}".`);
      },
    },
    list_favorites: {
      handler: () => {
        const s = dm.snapshot();
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
                },
          ),
        );
      },
    },
    play_favorite: {
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
            await queueAdd(
              host,
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
              lc(n.title) === lc(fav.title) &&
              (fav.artist == null || n.artist == null || lc(n.artist) === lc(fav.artist)),
          );
          if (match) {
            try {
              await queueAdd(host, server.udn, match.id, "PLAY_NOW", undefined, confirm);
            } catch (e) {
              if (e instanceof LargeQueueError)
                return err(largeQueueAsk(e.tracks, "play_favorite"));
              throw e;
            }
            dm.favoriteUpdate(a.key as string, {
              serverUdn: server.udn,
              serverName: server.name,
              objectId: match.id,
            });
            return ok(`Playing ${fav.title} (found on ${server.name}).`);
          }
        }
        return err(`Couldn't find "${fav.title}" on any media server right now.`);
      },
    },
    add_favorite: {
      inputSchema: {
        station_url: z.string().url().optional().describe("Favorite a station: its stream URL…"),
        station_name: z.string().optional().describe("…and its display name (both or neither)."),
      },
      handler: (a) => {
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
          };
        }
        const key = favoriteKey(fav);
        if (s.favorites.some((f) => favoriteKey(f) === key)) return ok("Already a favorite.");
        dm.favoriteAdd(fav);
        return ok(
          fav.kind === "station" ? `Favorited station ${fav.name}.` : `Favorited "${fav.title}".`,
        );
      },
    },
    remove_favorite: {
      inputSchema: { key: z.string().describe("Favorite key from list_favorites.") },
      handler: (a) => {
        const s = ctx.connected();
        const fav = s.favorites.find((f) => favoriteKey(f) === a.key);
        if (!fav) return err(`No favorite with key '${String(a.key)}'. Use list_favorites.`);
        dm.favoriteRemove(a.key as string);
        return ok(
          fav.kind === "station"
            ? `Removed station ${fav.name} from favorites.`
            : `Removed "${fav.title}" from favorites.`,
        );
      },
    },
  };
}
