import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { MediaInfoQuery } from "@shared/model";
import { IPC, type PushMessage, type StreamerCommand, type TastyTunesApi } from "@shared/ipc";
import {
  type AppSettings,
  type LyricsQuery,
  type MediaQueueAction,
  type SleepTimer,
} from "@shared/model";
import {
  type ContentRef,
  type Favorite,
  type Playlist,
  type PlaylistItem,
  type RecentTrack,
} from "@shared/model";

const api: TastyTunesApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  albumArt: (artist, album) => ipcRenderer.invoke(IPC.albumArt, artist, album),
  discover: () => ipcRenderer.invoke(IPC.discover),
  connect: (host: string) => ipcRenderer.invoke(IPC.connect, host),
  disconnect: () => ipcRenderer.invoke(IPC.disconnect),
  demoStart: () => ipcRenderer.invoke(IPC.demoStart),
  command: (cmd: StreamerCommand) => ipcRenderer.invoke(IPC.command, cmd),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.setSettings, patch),
  fetchArt: (url: string) => ipcRenderer.invoke(IPC.fetchArt, url),
  fetchLyrics: (query: LyricsQuery, force?: boolean) =>
    ipcRenderer.invoke(IPC.fetchLyrics, query, force),
  lbValidate: () => ipcRenderer.invoke(IPC.lbValidate),
  updateDownload: () => ipcRenderer.invoke(IPC.updateDownload),
  updateInstall: () => ipcRenderer.invoke(IPC.updateInstall),
  updateCheckNow: () => ipcRenderer.invoke(IPC.updateCheckNow),
  fetchArtistInfo: (artist: string, force?: boolean) =>
    ipcRenderer.invoke(IPC.fetchArtistInfo, artist, force),
  fetchAlbumInfo: (artist: string, album: string, force?: boolean) =>
    ipcRenderer.invoke(IPC.fetchAlbumInfo, artist, album, force),
  toggleMini: () => ipcRenderer.invoke(IPC.toggleMini),
  showMain: (screen?: string) => ipcRenderer.invoke(IPC.showMain, screen),
  setSleep: (sleep: SleepTimer | null) => ipcRenderer.invoke(IPC.setSleep, sleep),
  scheduleRunMissed: () => ipcRenderer.invoke(IPC.scheduleRunMissed),
  scheduleDismissMissed: () => ipcRenderer.invoke(IPC.scheduleDismissMissed),
  getRecents: () => ipcRenderer.invoke(IPC.getRecents),
  clearRecents: () => ipcRenderer.invoke(IPC.clearRecents),
  recentsRestore: (list: RecentTrack[]) => ipcRenderer.invoke(IPC.recentsRestore, list),
  favoriteAdd: (fav: Favorite) => ipcRenderer.invoke(IPC.favoriteAdd, fav),
  favoriteRemove: (key: string) => ipcRenderer.invoke(IPC.favoriteRemove, key),
  favoriteUpdate: (key: string, patch: Partial<Favorite>) =>
    ipcRenderer.invoke(IPC.favoriteUpdate, key, patch),
  playlistCreate: (name: string, items: PlaylistItem[]) =>
    ipcRenderer.invoke(IPC.playlistCreate, name, items),
  playlistRename: (id: string, name: string) => ipcRenderer.invoke(IPC.playlistRename, id, name),
  playlistDelete: (id: string) => ipcRenderer.invoke(IPC.playlistDelete, id),
  playlistRestore: (playlist: Playlist) => ipcRenderer.invoke(IPC.playlistRestore, playlist),
  queueRestore: (ref: ContentRef, position: number) =>
    ipcRenderer.invoke(IPC.queueRestore, ref, position),
  playlistSetItems: (id: string, items: PlaylistItem[]) =>
    ipcRenderer.invoke(IPC.playlistSetItems, id, items),
  playlistAppend: (id: string, items: PlaylistItem[]) =>
    ipcRenderer.invoke(IPC.playlistAppend, id, items),
  playlistActivate: (id: string) => ipcRenderer.invoke(IPC.playlistActivate, id),
  playlistActivateCancel: () => ipcRenderer.invoke(IPC.playlistActivateCancel),
  lookupCacheStats: () => ipcRenderer.invoke(IPC.lookupCacheStats),
  clearLookupCaches: () => ipcRenderer.invoke(IPC.clearLookupCaches),
  mediaServers: () => ipcRenderer.invoke(IPC.mediaServers),
  mediaBrowse: (serverUdn: string, objectId: string | null, titlePath: string[]) =>
    ipcRenderer.invoke(IPC.mediaBrowse, serverUdn, objectId, titlePath),
  mediaSearch: (serverUdn: string, query: string) =>
    ipcRenderer.invoke(IPC.mediaSearch, serverUdn, query),
  mediaSearchAll: (query: string) => ipcRenderer.invoke(IPC.mediaSearchAll, query),
  mediaIndexPools: () => ipcRenderer.invoke(IPC.mediaIndexPools),
  mediaQueueAdd: (
    serverUdn: string,
    objectId: string,
    action: MediaQueueAction,
    playFromId?: string,
  ) => ipcRenderer.invoke(IPC.mediaQueueAdd, serverUdn, objectId, action, playFromId),
  mediaPresetSave: (serverUdn: string, objectId: string, slot: number) =>
    ipcRenderer.invoke(IPC.mediaPresetSave, serverUdn, objectId, slot),
  contentResolve: (ref: ContentRef) => ipcRenderer.invoke(IPC.contentResolve, ref),
  mediaNodeInfo: (query: MediaInfoQuery) => ipcRenderer.invoke(IPC.mediaNodeInfo, query),
  mediaIndexRebuild: (serverUdn: string) => ipcRenderer.invoke(IPC.mediaIndexRebuild, serverUdn),
  radioSearch: (query: string) => ipcRenderer.invoke(IPC.radioSearch, query),
  radioTop: () => ipcRenderer.invoke(IPC.radioTop),
  radioByTags: (tags: string[]) => ipcRenderer.invoke(IPC.radioByTags, tags),
  onPush: (cb: (msg: PushMessage) => void) => {
    const listener = (_e: IpcRendererEvent, msg: PushMessage): void => cb(msg);
    ipcRenderer.on(IPC.push, listener);
    return () => {
      ipcRenderer.removeListener(IPC.push, listener);
    };
  },
};

contextBridge.exposeInMainWorld("tastytunes", api);
