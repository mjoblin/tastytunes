// The typed contract between main, preload, and renderer: what may be said,
// on which channel, in which direction.
//
// Two neighbours split out of here 2026-07-26 (in two passes), when this file
// had grown to ~1,600 lines and a contract change meant reading past a
// 490-line tool catalogue to find it:
//   · model.ts      — the app's own DOMAIN: everything that would still mean
//                     something with the IPC layer deleted (collections,
//                     settings, media browser, schedules, diagnostics…) plus
//                     the content-identity helpers. This file imports FROM it
//                     and must never import back, so the contract stays free
//                     of domain churn.
//   · mcpCatalog.ts — the MCP tool catalogue (it too leans on model, not here).
// smoip.ts is a different axis entirely — the STREAMER's wire types, which all
// three of these read and none of them own.
//
// What remains HERE is purely the conversation: channels (IPC), the preload
// surface (TastyTunesApi), the pushes (PushMessage), the commands
// (StreamerCommand), the boot snapshot, and the menu relay.

import type {
  Presets,
  QueueList,
  SystemInfo,
  SystemPower,
  SystemSources,
  SystemDisplay,
  SystemDisplaySpec,
  SystemPowerSpec,
  ZoneAudio,
  ZoneAudioSpec,
  ZoneNowPlaying,
  ZonePlayState,
  ZonePosition,
  ZoneState,
} from "./smoip";
import type {
  AlbumInfo,
  AppSettings,
  ArtistInfo,
  ConnectionState,
  ContentRef,
  DiscoveredDevice,
  Favorite,
  FirmwareStatus,
  FrameEntry,
  LogEntry,
  LyricsQuery,
  LyricsResult,
  McpStatus,
  MediaIndexPools,
  MediaIndexStatus,
  MediaNode,
  MediaQueueAction,
  MediaSearchAllGroup,
  MediaServerInfo,
  MissedSchedule,
  NetRequestEntry,
  Playlist,
  PlaylistActivation,
  PlaylistItem,
  QueueRestoreResult,
  RadioStation,
  ListeningRecordStats,
  RecentTrack,
  SleepTimer,
  UpdateCheckResult,
  UpdateState,
  MediaInfoQuery,
  MediaInfoTarget,
} from "./model";

/** The one copy of the project URL — user agents, Help menu, release pages. */
export const REPO_URL = "https://github.com/mjoblin/tastytunes";

// -------------------------------------------------------- main -> renderer push

/**
 * An application-menu click that must run in the renderer. Sent to the main
 * window only (never the mini player); `screen` values are renderer Screen ids.
 */
export type MenuCommand =
  | { id: "about" }
  | { id: "palette" }
  | { id: "shortcuts" }
  | { id: "displayMode" }
  | { id: "toggleNav" }
  | { id: "navBack" }
  | { id: "navForward" }
  | { id: "screen"; screen: string };

export type PushMessage =
  | { kind: "connection"; state: ConnectionState }
  | { kind: "devices"; devices: DiscoveredDevice[]; discovering: boolean }
  | { kind: "playState"; data: ZonePlayState }
  | { kind: "position"; data: ZonePosition }
  | { kind: "nowPlaying"; data: ZoneNowPlaying }
  | { kind: "zoneState"; data: ZoneState }
  | { kind: "queue"; data: QueueList }
  | { kind: "presets"; data: Presets }
  | { kind: "systemInfo"; data: SystemInfo }
  | { kind: "systemPower"; data: SystemPower }
  | { kind: "firmwareUpdate"; data: FirmwareStatus }
  | { kind: "sources"; data: SystemSources }
  | { kind: "zoneAudio"; data: ZoneAudio | null }
  | { kind: "audioSpec"; data: ZoneAudioSpec | null }
  | { kind: "systemDisplay"; data: SystemDisplay | null }
  | { kind: "displaySpec"; data: SystemDisplaySpec | null }
  | { kind: "powerSpec"; data: SystemPowerSpec | null }
  | { kind: "favorites"; data: Favorite[] }
  | { kind: "playlists"; data: Playlist[] }
  | { kind: "playlistActivation"; state: PlaylistActivation | null }
  | { kind: "frame"; entry: FrameEntry }
  | { kind: "log"; entry: LogEntry }
  | { kind: "recents"; data: RecentTrack[] }
  /** Settings changed OUTSIDE the renderer (e.g. an MCP tool created a schedule). */
  | { kind: "settings"; settings: AppSettings }
  /** Wake-on-intent in flight: a play-shaped command is waking the streamer. */
  | { kind: "waking"; waking: boolean }
  /** Cursor is over the mini window (CSS :hover can't fire over drag regions). */
  | { kind: "miniHover"; hovered: boolean }
  /**
   * The tray panel opened or closed. It is HIDDEN rather than destroyed
   * between uses, so the renderer never remounts and would otherwise have no
   * idea it had been reopened — which is what the open-on-a-sensible-tab
   * heuristic and the scroll-to-the-playing-row both key off.
   */
  | { kind: "trayPanel"; visible: boolean }
  | { kind: "sleep"; sleep: SleepTimer | null }
  | { kind: "recalledPreset"; id: number | null }
  | { kind: "mcpStatus"; status: McpStatus }
  | { kind: "scheduleMissed"; missed: MissedSchedule | null }
  | { kind: "mediaIndex"; statuses: MediaIndexStatus[] }
  | { kind: "menu"; command: MenuCommand }
  | { kind: "updateState"; state: UpdateState }
  /** Sent when a request starts (pending) and again when it settles — upsert by id. */
  | { kind: "netRequest"; entry: NetRequestEntry };

// ------------------------------------------------------ renderer -> main actions

export type StreamerCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "togglePlayback" }
  | { type: "nextTrack" }
  | { type: "previousTrack" }
  | { type: "seek"; positionSecs: number }
  | { type: "playQueueId"; queueId: number }
  | { type: "setRepeat"; mode: "all" | "off" }
  | { type: "setShuffle"; mode: "all" | "off" }
  /** skipVolume: a schedule bringing its own volume mutes the preset's override. */
  | { type: "recallPreset"; presetId: number; skipVolume?: boolean }
  | { type: "power"; power: "ON" | "NETWORK" | "toggle" }
  | { type: "setMute"; mute: boolean }
  | { type: "setSource"; sourceId: string }
  | { type: "setVolumeStep"; step: number }
  | { type: "setVolumePercent"; percent: number }
  | { type: "volumeStepChange"; delta: number }
  | { type: "queueDelete"; id: number }
  /** Clear the whole queue (the Queue screen's Clear button). */
  | { type: "queueClear" }
  | { type: "queueMove"; id: number; from: number; to: number }
  | { type: "presetDelete"; presetId: number }
  | { type: "presetMove"; from: number; to: number }
  /** Rename an existing preset (lets album saves carry a custom name). */
  | { type: "presetRename"; slot: number; name: string }
  /** Play an internet-radio stream by direct URL (/stream/radio — url+name both required). */
  | { type: "streamRadio"; url: string; name: string }
  /** Save the CURRENT playback to a preset slot (/zone/save_preset — the
   *  "save what's playing" verb; track-level for media, the natural verb for radio). */
  | { type: "zoneSavePreset"; slot: number }
  /** Snapshot the current queue into a device preset (type MediaQueue).
   *  null slot = firmware picks the next free one; null name = firmware default. */
  | { type: "queueSavePreset"; slot: number | null; name: string | null }
  // ---- /zone/audio tone controls (feature-detected via audioCaps; writes are
  // ---- ATOMIC on the firmware, so each command is exactly one logical control)
  /** Master EQ enable — boolean ON WRITE (the read returns an object). */
  | { type: "setUserEq"; enabled: boolean }
  /** One band's gain, dB (clamped to EQ_GAIN_MIN..MAX) — a slider release. */
  | { type: "setEqBandGain"; index: number; gain: number }
  /** All 7 gains in one frame — the "Flat" reset (official-app preset shape). */
  | { type: "setEqBands"; gains: number[] }
  | { type: "setTiltEq"; enabled: boolean }
  | { type: "setTiltIntensity"; intensity: number }
  | { type: "setBalance"; balance: number }
  // ---- §10 device controls (feature-detected via the /spec probes)
  /** Front-panel brightness: off | dim | bright. */
  | { type: "setBrightness"; brightness: string }
  /** Standby the unit drops into: ECO_MODE | NETWORK. */
  | { type: "setStandbyMode"; mode: string }
  /** Idle seconds before auto power-down; 0 = never. */
  | { type: "setAutoPowerDown"; seconds: number };

// -------------------------------------------------------------- boot-time snapshot

export interface Snapshot {
  connection: ConnectionState;
  devices: DiscoveredDevice[];
  discovering: boolean;
  settings: AppSettings;
  playState: ZonePlayState | null;
  position: ZonePosition | null;
  nowPlaying: ZoneNowPlaying | null;
  zoneState: ZoneState | null;
  queue: QueueList | null;
  presets: Presets | null;
  systemInfo: SystemInfo | null;
  systemPower: SystemPower | null;
  firmwareUpdate: FirmwareStatus | null;
  sources: SystemSources | null;
  /** Tone/EQ state (/zone/audio) — null when the streamer doesn't push it. */
  zoneAudio: ZoneAudio | null;
  /** Tone/EQ capability spec, probed over HTTP at connect; null = no tone controls. */
  audioSpec: ZoneAudioSpec | null;
  /** Front-panel display state (/system/display); null on headless models. */
  systemDisplay: SystemDisplay | null;
  /** Display + power capability specs, probed at connect. */
  displaySpec: SystemDisplaySpec | null;
  powerSpec: SystemPowerSpec | null;
  sleep: SleepTimer | null;
  /**
   * The preset most recently recalled THROUGH THIS APP (renderer, palette,
   * MCP, schedules) — the firmware keeps no recall state at all (verified
   * live), so this is the only "which preset did I pick" signal. Null on
   * startup and after device switches; consumers must content-check it
   * against what's actually playing before trusting it.
   */
  lastRecalledPresetId: number | null;
  recents: RecentTrack[];
  /** Local favorites (stations, albums, tracks), newest-hearted first. */
  favorites: Favorite[];
  /** Stored playlists, newest-updated first. */
  playlists: Playlist[];
  /** An activation in flight, so a window opened or reloaded mid-run shows it
   *  rather than a stale idle button (the did-finish-load rule). */
  playlistActivation: PlaylistActivation | null;
  mcpStatus: McpStatus;
  /** A wake missed while the machine slept, still worth offering. */
  missedSchedule: MissedSchedule | null;
  /** Local media-index state per known server. */
  mediaIndex: MediaIndexStatus[];
  frames: FrameEntry[];
  logs: LogEntry[];
  netRequests: NetRequestEntry[];
}

// ------------------------------------------------------------------- preload API

export interface TastyTunesApi {
  getSnapshot(): Promise<Snapshot>;
  /** Cover Art Archive fallback for an album the server has no art for (null when off or unknown). */
  albumArt(artist: string, album: string): Promise<string | null>;
  discover(): Promise<DiscoveredDevice[]>;
  connect(host: string): Promise<void>;
  disconnect(): Promise<void>;
  /** Start the built-in demo device and connect to it ("Try without a streamer"). */
  demoStart(): Promise<void>;
  command(cmd: StreamerCommand): Promise<void>;
  openExternal(url: string): Promise<void>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** Fetch album art via the main process (bypasses CORS) as a data URL. */
  fetchArt(url: string): Promise<{ dataUrl: string } | null>;
  /** Look up lyrics via LRCLIB (main process, in-memory cached; null = not found).
   *  `force` bypasses the cache read — the user-driven refresh. */
  fetchLyrics(query: LyricsQuery, force?: boolean): Promise<LyricsResult | null>;
  /** Check the saved ListenBrainz token (null = network failure, not a verdict). */
  lbValidate(): Promise<{ valid: boolean; userName: string | null } | null>;
  /** Consent step 1: start downloading the offered update. */
  updateDownload(): Promise<void>;
  /** Consent step 2: restart into the downloaded update now. */
  updateInstall(): Promise<void>;
  /** User-initiated release check (works with automatic checks off). */
  updateCheckNow(): Promise<UpdateCheckResult>;
  /** Artist bio via MusicBrainz + Wikipedia (main process, cached; null = no match).
   *  `force` bypasses the cache read — the user-driven refresh. */
  fetchArtistInfo(artist: string, force?: boolean): Promise<ArtistInfo | null>;
  /** Album details via MusicBrainz + Wikipedia (main process, cached; null = no match).
   *  `force` bypasses the cache read — the user-driven refresh. */
  fetchAlbumInfo(artist: string, album: string, force?: boolean): Promise<AlbumInfo | null>;
  /** Open/close the mini player window. */
  toggleMini(): Promise<void>;
  /** Show and focus the main window. */
  /**
   * Bring the main window up, optionally ON A GIVEN SCREEN — the tray panel
   * needs "open the app where the thing I can't do from here lives" (its
   * disconnected face sends people to Device to connect). Same door the tray
   * MENU's items use; without the argument it's the plain "just show it".
   */
  showMain(screen?: string): Promise<void>;
  /** Arm or clear the sleep timer (lives in the main process). */
  setSleep(sleep: SleepTimer | null): Promise<void>;
  /** Act on a wake missed during sleep — runs it exactly as the tick would. */
  scheduleRunMissed(): Promise<void>;
  /** Let it go: clears the offer without running anything. */
  scheduleDismissMissed(): Promise<void>;
  /** The local recently-played log, newest first. */
  getRecents(): Promise<RecentTrack[]>;
  /** Wipe the recently-played log. */
  clearRecents(): Promise<void>;
  /** Undo a clear: merges the snapshot back under anything logged since. */
  recentsRestore(list: RecentTrack[]): Promise<void>;
  /** Add a favorite (replaces any same-key entry); resolves to the new list. */
  favoriteAdd(fav: Favorite): Promise<Favorite[]>;
  /** Remove a favorite by its favoriteKey; resolves to the new list. */
  favoriteRemove(key: string): Promise<Favorite[]>;
  /** Patch a favorite in place (objectId healing after a search resolve). */
  favoriteUpdate(key: string, patch: Partial<Favorite>): Promise<Favorite[]>;
  /** Stored playlists. Writes return the whole list, like the favorites verbs —
   *  except create, which returns the CREATED playlist: its stored name may
   *  have been uniquified, so reporting the outcome (toast text, an MCP reply
   *  with the id) must read the result, not echo the request. */
  playlistCreate(name: string, items: PlaylistItem[]): Promise<Playlist>;
  playlistRename(id: string, name: string): Promise<Playlist[]>;
  playlistDelete(id: string): Promise<Playlist[]>;
  /** Undo a delete: puts the playlist back verbatim — same id, name, timestamps
   *  and place in the collection. NOT a create (see restorePlaylist). */
  playlistRestore(playlist: Playlist): Promise<Playlist[]>;
  /** Undo a queue removal: re-resolve the track by content, re-add it, and move
   *  it back to `position`. Best-effort — see QueueRestoreResult. */
  queueRestore(ref: ContentRef, position: number): Promise<QueueRestoreResult>;
  /** Replace a playlist's items wholesale — reorder and remove both land here. */
  playlistSetItems(id: string, items: PlaylistItem[]): Promise<Playlist[]>;
  /** Append to a playlist (duplicates allowed — an ordered list, not a set). */
  playlistAppend(id: string, items: PlaylistItem[]): Promise<Playlist[]>;
  /** Replace the streamer's queue with a playlist. Resolves when the run ends. */
  playlistActivate(id: string): Promise<PlaylistActivation>;
  /** Stop an in-flight activation; the queue keeps whatever landed. */
  playlistActivateCancel(): Promise<void>;
  /** UPnP media servers known to the streamer (its own USB storage included). */
  mediaServers(): Promise<MediaServerInfo[]>;
  /** Browse a ContentDirectory container (objectId null = root). `titlePath` is
   *  the breadcrumb titles from root — used to re-resolve stale ids after the
   *  streamer's USB ids rot across a standby cycle. */
  mediaBrowse(
    serverUdn: string,
    objectId: string | null,
    titlePath: string[],
  ): Promise<MediaNode[]>;
  /** Whole-library search on a searchable server (title/artist/album contains). */
  mediaSearch(serverUdn: string, query: string): Promise<{ items: MediaNode[]; total: number }>;
  /** Cross-server search: every READY index at once, grouped by server.
   *  Index-only by design — live fallback stays per-server (no SOAP fan-out). */
  mediaSearchAll(query: string): Promise<MediaSearchAllGroup[]>;
  /** Every ready index's full pools — feeds the Artists/Albums lenses. */
  mediaIndexPools(): Promise<MediaIndexPools[]>;
  /** Queue a browsed item on the streamer (DIDL stays in the main process). */
  mediaQueueAdd(
    serverUdn: string,
    objectId: string,
    action: MediaQueueAction,
    playFromId?: string,
  ): Promise<void>;
  /** Save a browsed item to a preset slot (1-99). */
  mediaPresetSave(serverUdn: string, objectId: string, slot: number): Promise<void>;
  /** Find a track by CONTENT on any server (index first, live fallback) —
   *  the renderer-facing face of main's resolveContent. Null when nothing
   *  matches or the device is disconnected. */
  contentResolve(
    ref: ContentRef,
  ): Promise<{ serverUdn: string; serverName: string; objectId: string } | null>;
  /** Everything the library knows about a thing a list holds only a ref to
   *  (queue row, favorite, playlist item…): the index by id, then by content,
   *  then a live BrowseMetadata when the server and id are known. Null when
   *  nothing is found — the caller shows what it has. */
  mediaNodeInfo(query: MediaInfoQuery): Promise<MediaInfoTarget | null>;
  /** Station search against radio-browser.info (main process; name contains, by popularity). */
  /** Force a media-index (re)build for one server (also the only way to
   *  build one for a Browse-only server). */
  mediaIndexRebuild(serverUdn: string): Promise<void>;
  radioSearch(query: string): Promise<RadioStation[]>;
  /** The directory's most-listened stations — the Radio screen's default rail. */
  radioTop(): Promise<RadioStation[]>;
  /** Stations for a curated category: any-of the given tags, popularity-ranked. */
  radioByTags(tags: string[]): Promise<RadioStation[]>;
  /** The listening record's truth row: events, bytes, since, health. */
  listeningStats(): Promise<ListeningRecordStats>;
  /** Delete the listening record's files (the UI confirms; no undo). */
  listeningClear(): Promise<ListeningRecordStats>;
  /** Save the whole record to one chosen file (the years concatenated — the
   *  per-line envelope makes that safe). Resolves to the written file's name
   *  and event count, or null if the save dialog was cancelled. */
  listeningExport(): Promise<{ file: string; events: number } | null>;
  /** Combined size of the on-disk lookup caches (lyrics, artist context). */
  lookupCacheStats(): Promise<{ entries: number; bytes: number }>;
  /** Wipe the lookup caches (memory + disk); resolves to the fresh stats. */
  clearLookupCaches(): Promise<{ entries: number; bytes: number }>;
  onPush(cb: (msg: PushMessage) => void): () => void;
}

export const IPC = {
  getSnapshot: "tt:getSnapshot",
  albumArt: "tt:albumArt",
  discover: "tt:discover",
  connect: "tt:connect",
  disconnect: "tt:disconnect",
  demoStart: "tt:demoStart",
  command: "tt:command",
  openExternal: "tt:openExternal",
  getSettings: "tt:getSettings",
  setSettings: "tt:setSettings",
  fetchArt: "tt:fetchArt",
  fetchLyrics: "tt:fetchLyrics",
  lbValidate: "tt:lbValidate",
  updateDownload: "tt:updateDownload",
  updateInstall: "tt:updateInstall",
  updateCheckNow: "tt:updateCheckNow",
  fetchArtistInfo: "tt:fetchArtistInfo",
  fetchAlbumInfo: "tt:fetchAlbumInfo",
  toggleMini: "tt:toggleMini",
  showMain: "tt:showMain",
  setSleep: "tt:setSleep",
  scheduleRunMissed: "tt:scheduleRunMissed",
  scheduleDismissMissed: "tt:scheduleDismissMissed",
  getRecents: "tt:getRecents",
  clearRecents: "tt:clearRecents",
  recentsRestore: "tt:recentsRestore",
  favoriteAdd: "tt:favoriteAdd",
  favoriteRemove: "tt:favoriteRemove",
  favoriteUpdate: "tt:favoriteUpdate",
  playlistCreate: "tt:playlistCreate",
  playlistRename: "tt:playlistRename",
  playlistDelete: "tt:playlistDelete",
  playlistRestore: "tt:playlistRestore",
  queueRestore: "tt:queueRestore",
  playlistSetItems: "tt:playlistSetItems",
  playlistAppend: "tt:playlistAppend",
  playlistActivate: "tt:playlistActivate",
  playlistActivateCancel: "tt:playlistActivateCancel",
  listeningStats: "tt:listeningStats",
  listeningClear: "tt:listeningClear",
  listeningExport: "tt:listeningExport",
  lookupCacheStats: "tt:lookupCacheStats",
  clearLookupCaches: "tt:clearLookupCaches",
  mediaServers: "tt:mediaServers",
  mediaBrowse: "tt:mediaBrowse",
  mediaSearch: "tt:mediaSearch",
  mediaSearchAll: "tt:mediaSearchAll",
  mediaIndexPools: "tt:mediaIndexPools",
  mediaQueueAdd: "tt:mediaQueueAdd",
  mediaPresetSave: "tt:mediaPresetSave",
  contentResolve: "tt:contentResolve",
  mediaNodeInfo: "tt:mediaNodeInfo",
  mediaIndexRebuild: "tt:mediaIndexRebuild",
  radioSearch: "tt:radioSearch",
  radioTop: "tt:radioTop",
  radioByTags: "tt:radioByTags",
  push: "tt:push",
} as const;
