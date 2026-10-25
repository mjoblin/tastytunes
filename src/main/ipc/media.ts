import { IPC } from "@shared/ipc";
import type { ContentRef, MediaInfoQuery, MediaQueueAction } from "@shared/model";
import { deviceManager, streamerHost } from "../app/runtime";
import { broadcastSettings } from "../app/broadcast";
import { getSettings, updateSettings } from "../data/persist";
import * as mediaIndex from "../media/mediaIndex";
import { lookupMediaInfo } from "../media/mediaInfo";
import { listRecentCandidates } from "../media/recentList";
import { browse as mediaBrowse, presetSave, queueAdd, refreshServers } from "../media/upnpBrowser";
import { handle } from "../app/guard";

/** The media browser: servers, the indexes, browse, search, queueing, presets from the library, content resolve and the info lookups. (Split out of index.ts's registerIpc in the 0.11.0 sweep.) */
export function registerMediaIpc(): void {
  // Media browser — every call needs the connected streamer's host.
  handle(IPC.mediaServers, async () => {
    const servers = await refreshServers(streamerHost());
    // Fire-and-forget freshness: Tier A indexes build/rebuild in the
    // background whenever the Library lists servers; statuses push as they go.
    mediaIndex.ensureFresh(streamerHost(), servers);
    return servers;
  });
  handle(IPC.mediaIndexRebuild, async (_e, serverUdn: string) => {
    const servers = await refreshServers(streamerHost());
    const server = servers.find((x) => x.udn === serverUdn);
    if (server) await mediaIndex.rebuild(streamerHost(), server);
  });
  // a server's own Recently added list: chosen, off, or back to the one found by its name
  handle(IPC.setRecentlyAddedList, async (_e, serverUdn: unknown, choice: unknown) => {
    if (typeof serverUdn !== "string" || !serverUdn) return;
    const lists = { ...getSettings().recentlyAddedLists };
    if (choice === null) delete lists[serverUdn];
    else if (choice === "off") lists[serverUdn] = "off";
    else if (
      choice != null &&
      typeof choice === "object" &&
      "id" in choice &&
      "title" in choice &&
      "titlePath" in choice &&
      typeof choice.id === "string" &&
      typeof choice.title === "string" &&
      Array.isArray(choice.titlePath) &&
      choice.titlePath.every((t) => typeof t === "string")
    )
      lists[serverUdn] = { id: choice.id, title: choice.title, titlePath: choice.titlePath };
    else return;
    broadcastSettings(updateSettings({ recentlyAddedLists: lists }));
    await mediaIndex.refreshRecentList(streamerHost(), serverUdn);
  });
  // the folders Settings › Libraries offers as a server's own list
  handle(IPC.recentListCandidates, async (_e, serverUdn: unknown) => {
    if (typeof serverUdn !== "string") return [];
    const servers = await refreshServers(streamerHost());
    const server = servers.find((x) => x.udn === serverUdn);
    return server ? listRecentCandidates(streamerHost(), server) : [];
  });
  handle(IPC.mediaBrowse, (_e, serverUdn: string, objectId: string | null, titlePath: string[]) =>
    mediaBrowse(streamerHost(), serverUdn, objectId, titlePath),
  );
  handle(IPC.mediaSearch, (_e, serverUdn: string, query: string) =>
    // Index-first: a fresh local index answers instantly; live search covers
    // the rest (building, Tier C, or no index yet).
    mediaIndex.searchServer(streamerHost(), serverUdn, query),
  );
  handle(IPC.mediaSearchAll, (_e, query: string) => mediaIndex.searchAllIndexes(query));
  handle(IPC.mediaIndexPools, () => mediaIndex.pools());
  handle(
    IPC.mediaQueueAdd,
    async (
      _e,
      serverUdn: string,
      objectId: string,
      action: MediaQueueAction,
      playFromId?: string,
      confirmLarge?: boolean,
    ) => {
      // Library plays are wake intents too — queue writes to a standby
      // streamer would otherwise land on deaf ears (probed 2026-07-23).
      await deviceManager.ensureAwake();
      return queueAdd(streamerHost(), serverUdn, objectId, action, playFromId, {
        confirmLarge: confirmLarge === true,
      });
    },
  );
  handle(IPC.mediaPresetSave, (_e, serverUdn: string, objectId: string, slot: number) =>
    presetSave(streamerHost(), serverUdn, objectId, slot),
  );
  handle(IPC.contentResolve, (_e, ref: ContentRef) => deviceManager.contentResolve(ref));
  handle(IPC.mediaNodeInfo, (_e, query: MediaInfoQuery, purpose: unknown) => {
    const conn = deviceManager.snapshot().connection;
    // anything but an explicit act is a show: a show never rebuilds an index
    return lookupMediaInfo(
      conn.phase === "connected" ? conn.host : null,
      query,
      purpose === "act" ? "act" : "show",
    );
  });
}
