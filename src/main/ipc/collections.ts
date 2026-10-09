import { IPC } from "@shared/ipc";
import type { ContentRef, Favorite, Playlist, PlaylistItem, RecentTrack } from "@shared/model";
import { deviceManager } from "../app/runtime";
import { isPanelSender, notePanelActivationEnd, notePanelActivationStart } from "../app/tray";
import { getRecents } from "../data/recents";
import { decorateRecents, recentCoverGet, setRecentArtNotifier } from "../lookups/recentArt";
import { handle } from "../app/guard";

/** The collections: recently played, favorites, playlists and the queue restore. (Split out of index.ts's registerIpc in the 0.11.0 sweep.) */
export function registerCollectionsIpc(): void {
  handle(IPC.getRecents, () => decorateRecents(getRecents()));
  handle(IPC.recentCover, (_e, key: string) =>
    typeof key === "string" ? recentCoverGet(key) : null,
  );
  setRecentArtNotifier(() => deviceManager.repushRecents());
  handle(IPC.clearRecents, () => deviceManager.clearRecents());
  handle(IPC.recentsRestore, (_e, list: RecentTrack[]) => deviceManager.recentsRestore(list));
  handle(IPC.favoriteAdd, (_e, fav: Favorite) => deviceManager.favoriteAdd(fav));
  handle(IPC.favoriteRemove, (_e, key: string) => deviceManager.favoriteRemove(key));
  handle(IPC.favoriteUpdate, (_e, key: string, patch: Partial<Favorite>) =>
    deviceManager.favoriteUpdate(key, patch),
  );
  handle(IPC.playlistCreate, (_e, name: string, items: PlaylistItem[]) =>
    deviceManager.playlistCreate(name, items),
  );
  handle(IPC.playlistRename, (_e, id: string, name: string) =>
    deviceManager.playlistRename(id, name),
  );
  handle(IPC.playlistDelete, (_e, id: string) => deviceManager.playlistDelete(id));
  handle(IPC.playlistRestore, (_e, playlist: Playlist) => deviceManager.playlistRestore(playlist));
  handle(IPC.queueRestore, (_e, ref: ContentRef, position: number) =>
    deviceManager.queueRestore(ref, position),
  );
  handle(IPC.playlistSetItems, (_e, id: string, items: PlaylistItem[]) =>
    deviceManager.playlistSetItems(id, items),
  );
  handle(IPC.playlistAppend, (_e, id: string, items: PlaylistItem[]) =>
    deviceManager.playlistAppend(id, items),
  );
  // The tray panel gets special handling around this one verb, and it's
  // identified by its SENDER rather than by anything it tells us: a run started
  // from the panel holds the panel open against an accidental blur, and if the
  // panel was deliberately closed mid-run its report becomes an OS
  // notification. See tray.ts for the ruling.
  handle(IPC.playlistActivate, async (e, id: string) => {
    const fromPanel = isPanelSender(e.sender);
    if (fromPanel) notePanelActivationStart(id);
    try {
      const result = await deviceManager.playlistActivate(id);
      if (fromPanel) notePanelActivationEnd(result);
      return result;
    } catch (err) {
      if (fromPanel) notePanelActivationEnd(null);
      throw err;
    }
  });
  handle(IPC.playlistActivateCancel, () => deviceManager.cancelPlaylistActivation());
}
