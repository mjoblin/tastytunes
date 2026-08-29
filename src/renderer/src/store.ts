import { create } from "zustand";
import type { MenuCommand, PushMessage, Snapshot } from "@shared/ipc";
import type {
  AppSettings,
  ConnectionState,
  DiscoveredDevice,
  FirmwareStatus,
  FrameEntry,
  LogEntry,
  McpStatus,
  MediaIndexStatus,
  MissedSchedule,
  NetRequestEntry,
  UpdateState,
  SleepTimer,
  MediaSearchAllGroup,
  MediaNode,
} from "@shared/model";
import type {
  Favorite,
  RecentTrack,
  Playlist,
  PlaylistActivation,
  MediaInfoTarget,
} from "@shared/model";
import type {
  Presets,
  QueueList,
  QueueListItem,
  SystemDisplay,
  SystemDisplaySpec,
  SystemInfo,
  SystemPower,
  SystemPowerSpec,
  SystemSources,
  ZoneAudio,
  ZoneAudioSpec,
  ZoneNowPlaying,
  ZonePlayState,
  ZoneState,
} from "@shared/smoip";
import {
  type ListeningRecordStats,
  DEFAULT_SETTINGS,
  FRAME_RING_SIZE,
  LOG_RING_SIZE,
  NET_RING_SIZE,
} from "@shared/model";
import { currentLibrarySpot } from "@/lib/navSpot";
import { tt } from "./api";

export type Screen =
  | "now-playing"
  | "queue"
  | "search"
  | "presets"
  | "library"
  | "radio"
  | "favorites"
  | "playlists"
  | "recently-played"
  | "device"
  | "settings";

/**
 * A Library spot as HISTORY remembers it — the Library's own snapshot shape
 * (folder, search view, lens). Back and forward restore one of these.
 */
export interface LibrarySpot {
  udn: string | null;
  path: Array<{ id: string; title: string; node?: MediaNode }>;
  mode: boolean;
  query: string;
  searchNow: { query: string; items: MediaNode[]; total: number } | null;
  crossNow: { query: string; groups: MediaSearchAllGroup[] } | null;
  lens: "albums" | "artists" | null;
}

/**
 * One step of navigation history: the spot being LEFT — a screen, plus the
 * Library's snapshot when that screen was the Library. ONE STACK across
 * screens and within the Library (2026-08-23, user ask): back undoes the most
 * recent navigation whatever kind it was — the browser rule, and the only one
 * people can predict. Two stacks (screen-level and folder-level) made ⌘← in an
 * album mean "parent folder" even when you had just arrived from the Queue.
 */
export interface NavEntry {
  screen: Screen;
  library?: LibrarySpot;
}

/** A Library destination planted by another screen (Favorites "open album"):
 *  the LibraryScreen consumes it on its next mount/reset and navigates there. */
export interface LibraryTarget {
  serverUdn: string;
  objectId: string;
  /** Breadcrumb titles from root INCLUDING the target's own title — feeds the
   *  browse re-walk when the stored objectId has rotted. */
  titlePath: string[];
  title: string;
  /** A track to land on: scrolled to and flashed once the album's listing lands. */
  track?: string;
  /** Planted by unified search: the Library shows a "Search" crumb that leads
   *  BACK to the Search screen, instead of stranding you in a browse tree you
   *  never navigated into. */
  fromSearch?: boolean;
  /**
   * The libraryResetNonce this target belongs to. The consuming effect keys
   * on nonce EQUALITY instead of consume-and-clear: StrictMode double-runs
   * mount effects in dev, and a cleared target made the second run reset to
   * the source list (the "lands on top-level Library" bug). A stale nonce
   * just means "ordinary reset".
   */
  nonce: number;
}

/** The station most recently streamed BY THIS APP this session — the only way
 *  Now Playing can heart a radio stream (play_state carries no URL). */
export interface LastStation {
  url: string;
  name: string;
  favicon: string | null;
  radioBrowserUuid: string | null;
}

/**
 * The one transient-feedback slot (single toast, replace-don't-stack).
 * Reserved for actions whose effect isn't visible from the current screen
 * and for failed fire-and-forget streamer writes — continuous state (volume,
 * transport, connection) has its own live surfaces and never toasts.
 */
export interface ToastData {
  /** Monotonic nonce so an identical replacement still restarts the timer. */
  id: number;
  kind: "success" | "error";
  text: string;
  action?: ToastAction;
}

/**
 * A toast's optional button, in two shapes on purpose.
 *
 * `screen` JUMPS to where the effect lives — the original doctrine, for an
 * effect you can't see from here. `undo` REVERSES what just happened, and is
 * the app's whole undo surface: the offer lives and dies with its toast, so
 * there is no invisible undo state and no stack to reason about. Replacing the
 * toast drops the offer, which is exactly the single-slot semantics we want.
 *
 * An undo toast also gets a longer window than a plain confirmation (ToastHost)
 * — reading a confirmation is passive, taking an offer is a decision.
 */
export type ToastAction =
  | { label: string; screen: Screen; undo?: never }
  | { label: string; undo: () => void; screen?: never };
let toastNonce = 0;
/** Monotonic id for search asks — see librarySearchTarget. */
let librarySearchSeq = 0;
/** Monotonic id for unified-search asks — see searchRequest. */
let searchSeq = 0;

interface PlayheadSync {
  secs: number;
  at: number; // Date.now() when received — the UI interpolates from here
}

interface TTState {
  screen: Screen;
  /** Bumped when the FRONT DOOR is asked for — "Library" re-invoked while
   *  already on the screen — and by openInLibrary, which plants a destination
   *  stamped with the new value. A bump means "don't restore the last
   *  position"; plain navigation back to the library no longer bumps. */
  libraryResetNonce: number;
  /** Navigation history — see NavEntry. Back pops navBackStack; forward pops navForwardStack. */
  navBackStack: NavEntry[];
  navForwardStack: NavEntry[];
  /** A Library spot to restore after back/forward landed on the Library (one-shot, by nonce). */
  navRestore: { nonce: number; spot: LibrarySpot } | null;
  /** true while the current screen was reached by Back/Forward — history restores, intent prepares (the Search box and the Library's search bar only take focus on intent). */
  arrivedByHistory: boolean;
  /** Record the spot being left by an in-Library move (the Library calls this). */
  navPush: (entry: NavEntry) => void;
  goBack: () => void;
  goForward: () => void;
  clearNavRestore: () => void;
  connection: ConnectionState;
  devices: DiscoveredDevice[];
  discovering: boolean;
  settings: AppSettings;

  playState: ZonePlayState | null;
  nowPlaying: ZoneNowPlaying | null;
  zoneState: ZoneState | null;
  queue: QueueList | null;
  presets: Presets | null;
  systemInfo: SystemInfo | null;
  systemPower: SystemPower | null;
  /** A wake-on-intent is in flight (playing something from standby). */
  waking: boolean;
  /** Last standby_mode seen from ANY device this session — survives the
   *  disconnect blanking so the ConnectGate can suggest eco standby. */
  lastStandbyMode: SystemPower["standby_mode"] | null;
  /** Read-only streamer firmware status (PASSIVE — shown, never acted on). */
  firmwareUpdate: FirmwareStatus | null;
  sources: SystemSources | null;
  /** Tone/EQ state, live-mirrored (the streamer pushes /zone/audio on change). */
  zoneAudio: ZoneAudio | null;
  /** Tone/EQ capability spec (null = this streamer has no tone controls). */
  audioSpec: ZoneAudioSpec | null;
  /** Front-panel display + power/standby state and capability specs (§10 controls). */
  systemDisplay: SystemDisplay | null;
  displaySpec: SystemDisplaySpec | null;
  powerSpec: SystemPowerSpec | null;
  playhead: PlayheadSync | null;

  frames: FrameEntry[];
  logs: LogEntry[];
  /** Outbound HTTP requests from the main process (diagnostics Requests tab). */
  netRequests: NetRequestEntry[];

  diagnosticsOpen: boolean;
  shortcutsOpen: boolean;
  infoOpen: boolean;
  /** The media Info modal's subject; null = closed. */
  mediaInfo: MediaInfoTarget | null;
  paletteOpen: boolean;
  displayMode: boolean;
  /** Lyrics drawer on the Now Playing screen (ephemeral, not persisted). */
  lyricsOpen: boolean;
  /** Artist-context drawer on Now Playing (mutually exclusive with lyrics). */
  artistOpen: boolean;
  /** Active tab in the context drawer — remembered for the session only. */
  contextTab: "artist" | "album";
  /** Per-screen list filters — session only; always visible in the screen's header box. */
  screenFilters: {
    queue: string;
    presets: string;
    library: string;
    favorites: string;
    playlists: string;
    "recently-played": string;
  };
  /** True while the full-window ambient backdrop is showing — chrome goes transparent. */
  ambientWindowActive: boolean;
  /** Mini window only: cursor is over the window (pushed from main). */
  miniHover: boolean;
  /**
   * Tray panel only. It is HIDDEN rather than destroyed between uses, so the
   * renderer never remounts — `trayOpens` counts openings so an effect can
   * fire on each one (pick the right tab, scroll to the playing row), which a
   * bare boolean couldn't do for two opens in a row on the same tab.
   */
  trayPanelVisible: boolean;
  trayOpens: number;
  /** Live sleep timer, mirrored from the main process (arm via tt.setSleep). */
  sleep: SleepTimer | null;
  /** Local recently-played log, newest first (mirrored from the main process). */
  recents: RecentTrack[];
  /** The listening record's truth row, pushed after every append. Null until
   *  the History tab's first fetch or the first push. */
  listeningStats: ListeningRecordStats | null;
  /** Local favorites, newest-hearted first (mirrored from the main process). */
  favorites: Favorite[];
  playlists: Playlist[];
  /** Live playlist-activation progress (null when idle). */
  playlistActivation: PlaylistActivation | null;
  /** See LibraryTarget — set by Favorites, consumed by LibraryScreen. */
  libraryTarget: LibraryTarget | null;
  /** See LastStation — session-only, set by every in-app streamRadio play. */
  lastStation: LastStation | null;
  /** MCP server state, mirrored from the main process. */
  mcpStatus: McpStatus;
  /** A wake schedule missed while the computer slept — offered, never fired.
   *  The Schedules tab shows it; the OS notification is the other surface. */
  missedSchedule: MissedSchedule | null;
  /** Local media-index state per known server (Settings + Library UI). */
  mediaIndex: MediaIndexStatus[];
  /** Self-update consent-flow state, mirrored from the main process. */
  update: UpdateState | null;
  /** One-shot deep link into a Settings tab (e.g. the nav update dot →
   *  Updates); SettingsScreen consumes and clears it. */
  settingsJump: string | null;
  jumpToSettingsTab: (tab: string) => void;
  clearSettingsJump: () => void;
  /**
   * One-shot ask: open the Library ready to search (palette / ⌘F).
   *
   * Carries its OWN id rather than pairing with the reset nonce as it used to.
   * ⌘F must not take the front-door path — resetting the browse tree under a
   * search means exiting the search drops you at the root instead of where you
   * were — so it no longer bumps that nonce, which leaves the nonce unable to
   * tell two consecutive ⌘F presses apart. The consumer claims an id once and
   * clears the ask (see clearLibrarySearchTarget), which is what keeps a stale
   * ask from re-firing on a later mount.
   */
  librarySearchTarget: { id: number; query?: string } | null;
  /** `query` seeds the search box (the Search→Library handoff: "See all N in
   *  the Library" brings the unified query along). Without it, ⌘F semantics —
   *  find-recall brings back the last search. */
  requestLibrarySearch: (query?: string) => void;
  clearLibrarySearchTarget: () => void;
  /**
   * One-shot ask: open the unified Search screen with its input focused.
   * Same id-and-clear contract as librarySearchTarget — a request made before
   * the screen mounts still lands, and it can't re-fire on a later mount.
   * `query` seeds the box (the Library→Search pivot: "Search everywhere for
   * <artist>"); without it the recalled query is merely selected.
   */
  searchRequest: { id: number; query?: string } | null;
  /** A pivot ("Search everywhere for X" from a ⋯ menu) is an ordinary
   *  navigation: the one history records where it left, so ⌘← returns there.
   *  (Until 2026-08-23 a parallel back-pointer recorded by the pivot did this.) */
  requestSearch: (query?: string) => void;
  clearSearchRequest: () => void;
  /** One-shot ask: open Playlists with this playlist selected (search results
   *  OPEN a playlist rather than playing it — containers open, leaves play). */
  playlistsJump: string | null;
  jumpToPlaylist: (id: string) => void;
  clearPlaylistsJump: () => void;

  toast: ToastData | null;
  showToast: (toast: Omit<ToastData, "id">) => void;
  dismissToast: () => void;
  /** In-app recall memory (see Snapshot.lastRecalledPresetId). */
  lastRecalledPresetId: number | null;
  setScreen: (screen: Screen) => void;
  setDiagnosticsOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setInfoOpen: (open: boolean) => void;
  setMediaInfo: (target: MediaInfoTarget | null) => void;
  setPaletteOpen: (open: boolean) => void;
  setDisplayMode: (on: boolean) => void;
  setLyricsOpen: (open: boolean) => void;
  setArtistOpen: (open: boolean) => void;
  setContextTab: (tab: "artist" | "album") => void;
  setScreenFilter: (screen: keyof TTState["screenFilters"], text: string) => void;
  /** Navigate to the Library opened at a specific node (Favorites → album). */
  openInLibrary: (target: Omit<LibraryTarget, "nonce">) => void;
  clearLibraryTarget: () => void;
  setLastStation: (st: LastStation) => void;
  setAmbientWindowActive: (on: boolean) => void;
  setSettings: (settings: AppSettings) => void;
  /** THE settings write path: round-trip through main, adopt the result. */
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setQueueItems: (items: QueueListItem[]) => void;
  init: (snapshot: Snapshot) => void;
  applyPush: (msg: PushMessage) => void;
  /** Application-menu clicks forwarded from the main process (main window only). */
  applyMenu: (command: MenuCommand) => void;
}

/** The spot being left right now, as a history entry (the Library's snapshot rides along). */
const leaving = (s: { screen: Screen }): NavEntry =>
  s.screen === "library" && currentLibrarySpot()
    ? { screen: "library", library: currentLibrarySpot() ?? undefined }
    : { screen: s.screen };
/** History push for a navigation to `screen` from state `s` — nothing for a same-screen re-invoke. */
const navTo = (
  s: { screen: Screen; navBackStack: NavEntry[] },
  screen: Screen,
): Partial<{ navBackStack: NavEntry[]; navForwardStack: NavEntry[]; arrivedByHistory: boolean }> =>
  screen === s.screen
    ? {}
    : {
        navBackStack: [...s.navBackStack, leaving(s)],
        navForwardStack: [],
        arrivedByHistory: false,
      };
let navRestoreSeq = 0;

export const useStore = create<TTState>((set, get) => ({
  screen: "now-playing",
  libraryResetNonce: 0,
  navBackStack: [],
  navForwardStack: [],
  navRestore: null,
  arrivedByHistory: false,
  navPush: (entry) =>
    set((s) => ({ navBackStack: [...s.navBackStack, entry], navForwardStack: [] })),
  goBack: () => {
    const s = get();
    const entry = s.navBackStack[s.navBackStack.length - 1];
    if (!entry) return;
    set({
      navBackStack: s.navBackStack.slice(0, -1),
      navForwardStack: [...s.navForwardStack, leaving(s)],
      screen: entry.screen,
      arrivedByHistory: true,
      navRestore: entry.library ? { nonce: ++navRestoreSeq, spot: entry.library } : null,
    });
  },
  goForward: () => {
    const s = get();
    const entry = s.navForwardStack[s.navForwardStack.length - 1];
    if (!entry) return;
    set({
      navForwardStack: s.navForwardStack.slice(0, -1),
      navBackStack: [...s.navBackStack, leaving(s)],
      screen: entry.screen,
      arrivedByHistory: true,
      navRestore: entry.library ? { nonce: ++navRestoreSeq, spot: entry.library } : null,
    });
  },
  clearNavRestore: () => set({ navRestore: null }),
  connection: { phase: "idle" },
  devices: [],
  discovering: false,
  settings: DEFAULT_SETTINGS,

  playState: null,
  nowPlaying: null,
  zoneState: null,
  queue: null,
  presets: null,
  systemInfo: null,
  systemPower: null,
  waking: false,
  lastStandbyMode: null,
  firmwareUpdate: null,
  sources: null,
  zoneAudio: null,
  audioSpec: null,
  systemDisplay: null,
  displaySpec: null,
  powerSpec: null,
  playhead: null,

  frames: [],
  logs: [],
  netRequests: [],

  diagnosticsOpen: false,
  shortcutsOpen: false,
  infoOpen: false,
  mediaInfo: null,
  paletteOpen: false,
  displayMode: false,
  lyricsOpen: false,
  artistOpen: false,
  contextTab: "artist",
  screenFilters: {
    queue: "",
    presets: "",
    library: "",
    favorites: "",
    playlists: "",
    "recently-played": "",
  },
  ambientWindowActive: false,
  miniHover: false,
  trayPanelVisible: false,
  trayOpens: 0,
  sleep: null,
  recents: [],
  listeningStats: null,
  favorites: [],
  playlists: [],
  playlistActivation: null,
  libraryTarget: null,
  lastStation: null,
  mcpStatus: { running: false, url: null, error: null },
  missedSchedule: null,
  mediaIndex: [],
  update: null,
  settingsJump: null,
  jumpToSettingsTab: (tab) => {
    get().setScreen("settings");
    set({ settingsJump: tab });
  },
  clearSettingsJump: () => set({ settingsJump: null }),
  librarySearchTarget: null,
  requestLibrarySearch: (query) =>
    // Deliberately NOT setScreen('library'): from inside the Library that's the
    // front door, and a ⌘F shouldn't throw away where you were browsing.
    set((s) => ({
      ...navTo(s, "library"),
      screen: "library",
      librarySearchTarget: { id: ++librarySearchSeq, query },
    })),
  clearLibrarySearchTarget: () => set({ librarySearchTarget: null }),
  searchRequest: null,
  requestSearch: (query) =>
    set((s) => ({
      ...navTo(s, "search"),
      screen: "search",
      searchRequest: { id: ++searchSeq, query },
    })),
  clearSearchRequest: () => set({ searchRequest: null }),
  playlistsJump: null,
  jumpToPlaylist: (id) =>
    set((s) => ({
      ...navTo(s, "playlists"),
      screen: "playlists",
      playlistsJump: id,
    })),
  clearPlaylistsJump: () => set({ playlistsJump: null }),

  toast: null,
  showToast: (toast) => set({ toast: { ...toast, id: ++toastNonce } }),
  dismissToast: () => set({ toast: null }),
  lastRecalledPresetId: null,
  /**
   * Library is the only screen with a memory to disturb, so it's the only one
   * with a rule here: asking for Library WHILE ALREADY THERE is the front door
   * and resets to the source list; ARRIVING from another screen picks up where
   * the last visit left off.
   *
   * This reverses T3 (2026-07-17), which bumped on every navigation because
   * "Library means the front door" and there was no other way back to the top.
   * There are two now — re-clicking the nav row from inside the screen, and the
   * breadcrumb root — so the reset keeps its escape hatch while a browse tree
   * stops forgetting your place every time you glance at Now Playing.
   */
  setScreen: (screen) =>
    set((s) => ({
      // any plain navigation invalidates the pivot's back-link — browser
      // rules: going somewhere new kills the stale "back"
      // …and records the spot being left (history); a same-screen re-invoke
      // of the Library is its front-door reset, not a navigation
      ...navTo(s, screen),
      ...(screen === "library" && s.screen === "library"
        ? { screen, libraryResetNonce: s.libraryResetNonce + 1 }
        : { screen }),
    })),
  setDiagnosticsOpen: (diagnosticsOpen) => set({ diagnosticsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setInfoOpen: (infoOpen) => set({ infoOpen }),
  setMediaInfo: (mediaInfo) => set({ mediaInfo }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setDisplayMode: (displayMode) => set({ displayMode }),
  // The two Now Playing drawers are mutually exclusive — opening one closes
  // the other here, so every opener (header buttons, future palette entries)
  // inherits the rule.
  setLyricsOpen: (lyricsOpen) =>
    set(lyricsOpen ? { lyricsOpen, artistOpen: false } : { lyricsOpen }),
  setArtistOpen: (artistOpen) =>
    set(artistOpen ? { artistOpen, lyricsOpen: false } : { artistOpen }),
  setContextTab: (contextTab) => set({ contextTab }),
  setScreenFilter: (screen, text) =>
    set((s) => ({ screenFilters: { ...s.screenFilters, [screen]: text } })),
  // The target is stamped with the nonce it belongs to — the consuming
  // effect matches on it (idempotent; see LibraryTarget.nonce).
  openInLibrary: (target) =>
    set((s) => ({
      ...navTo(s, "library"),
      libraryTarget: { ...target, nonce: s.libraryResetNonce + 1 },
      screen: "library",
      libraryResetNonce: s.libraryResetNonce + 1,
    })),
  clearLibraryTarget: () => set({ libraryTarget: null }),
  setLastStation: (lastStation) => set({ lastStation }),
  setAmbientWindowActive: (ambientWindowActive) => set({ ambientWindowActive }),
  setSettings: (settings) => set({ settings }),
  saveSettings: async (patch) => {
    const settings = await tt.setSettings(patch);
    set({ settings });
  },
  setQueueItems: (items) => set((s) => (s.queue ? { queue: { ...s.queue, items } } : {})),

  init: (snap) =>
    set({
      connection: snap.connection,
      devices: snap.devices,
      discovering: snap.discovering,
      settings: snap.settings,
      playState: snap.playState,
      nowPlaying: snap.nowPlaying,
      zoneState: snap.zoneState,
      lastRecalledPresetId: snap.lastRecalledPresetId,
      queue: snap.queue,
      presets: snap.presets,
      systemInfo: snap.systemInfo,
      systemPower: snap.systemPower,
      // The eco hint needs the standby mode even when systemPower arrives via
      // the boot snapshot rather than a push (fresh launches).
      ...(snap.systemPower?.standby_mode != null
        ? { lastStandbyMode: snap.systemPower.standby_mode }
        : {}),
      firmwareUpdate: snap.firmwareUpdate,
      sources: snap.sources,
      zoneAudio: snap.zoneAudio,
      audioSpec: snap.audioSpec,
      systemDisplay: snap.systemDisplay,
      displaySpec: snap.displaySpec,
      powerSpec: snap.powerSpec,
      sleep: snap.sleep,
      recents: snap.recents,
      favorites: snap.favorites,
      playlists: snap.playlists,
      playlistActivation: snap.playlistActivation,
      mcpStatus: snap.mcpStatus,
      missedSchedule: snap.missedSchedule,
      mediaIndex: snap.mediaIndex,
      playhead: snap.position ? { secs: snap.position.position, at: Date.now() } : null,
      frames: snap.frames,
      logs: snap.logs,
      netRequests: snap.netRequests,
    }),

  applyPush: (msg) =>
    set((s) => {
      switch (msg.kind) {
        case "connection": {
          // Connecting to a DIFFERENT device blanks the previous streamer's
          // state — its queue/presets otherwise linger until the new device's
          // pushes land. Same-host reconnects keep state: brief drops must
          // not flash the UI empty, and fresh pushes overwrite anyway.
          const prevHost = "host" in s.connection ? s.connection.host : null;
          const nextHost = "host" in msg.state ? msg.state.host : null;
          if (msg.state.phase === "connecting" && prevHost != null && nextHost !== prevHost) {
            return {
              connection: msg.state,
              playState: null,
              nowPlaying: null,
              zoneState: null,
              queue: null,
              presets: null,
              systemInfo: null,
              systemPower: null,
              firmwareUpdate: null,
              sources: null,
              zoneAudio: null,
              audioSpec: null,
              systemDisplay: null,
              displaySpec: null,
              powerSpec: null,
              sleep: null,
              playhead: null,
            };
          }
          return { connection: msg.state };
        }
        case "devices":
          return { devices: msg.devices, discovering: msg.discovering };
        case "playState":
          return {
            playState: msg.data,
            playhead:
              msg.data.position != null ? { secs: msg.data.position, at: Date.now() } : s.playhead,
          };
        case "position":
          return { playhead: { secs: msg.data.position, at: Date.now() } };
        case "nowPlaying":
          return { nowPlaying: msg.data };
        case "zoneState":
          return { zoneState: msg.data };
        case "queue":
          return { queue: msg.data };
        case "presets":
          return { presets: msg.data };
        case "systemInfo":
          return { systemInfo: msg.data };
        case "systemPower":
          return {
            systemPower: msg.data,
            lastStandbyMode: msg.data?.standby_mode ?? s.lastStandbyMode,
          };
        case "waking":
          return { waking: msg.waking };
        case "firmwareUpdate":
          return { firmwareUpdate: msg.data };
        case "sources":
          return { sources: msg.data };
        case "zoneAudio":
          return { zoneAudio: msg.data };
        case "audioSpec":
          return { audioSpec: msg.data };
        case "systemDisplay":
          return { systemDisplay: msg.data };
        case "displaySpec":
          return { displaySpec: msg.data };
        case "powerSpec":
          return { powerSpec: msg.data };
        case "frame": {
          const frames = [...s.frames, msg.entry];
          if (frames.length > FRAME_RING_SIZE) frames.splice(0, frames.length - FRAME_RING_SIZE);
          return { frames };
        }
        case "log": {
          const logs = [...s.logs, msg.entry];
          if (logs.length > LOG_RING_SIZE) logs.splice(0, logs.length - LOG_RING_SIZE);
          return { logs };
        }
        case "miniHover":
          return { miniHover: msg.hovered };
        case "trayPanel":
          return {
            trayPanelVisible: msg.visible,
            trayOpens: msg.visible ? s.trayOpens + 1 : s.trayOpens,
          };
        case "sleep":
          return { sleep: msg.sleep };
        case "recalledPreset":
          return { lastRecalledPresetId: msg.id };
        case "recents":
          return { recents: msg.data };
        case "listening":
          return { listeningStats: msg.data };
        case "favorites":
          return { favorites: msg.data };
        case "mcpStatus":
          return { mcpStatus: msg.status };
        case "scheduleMissed":
          return { missedSchedule: msg.missed };
        case "mediaIndex":
          return { mediaIndex: msg.statuses };
        case "updateState":
          return { update: msg.state.phase === "idle" ? null : msg.state };
        case "netRequest": {
          // start + settle arrive as separate pushes for the same id — upsert
          const idx = s.netRequests.findIndex((e) => e.id === msg.entry.id);
          const netRequests =
            idx >= 0
              ? s.netRequests.map((e, i) => (i === idx ? msg.entry : e))
              : [...s.netRequests, msg.entry];
          if (netRequests.length > NET_RING_SIZE)
            netRequests.splice(0, netRequests.length - NET_RING_SIZE);
          return { netRequests };
        }
        case "menu":
          return {}; // routed to applyMenu in main.tsx; nothing to merge here
        case "playlists":
          return { playlists: msg.data };
        case "playlistActivation":
          return { playlistActivation: msg.state };
        case "settings":
          // settings changed outside the renderer (an MCP tool edited
          // schedules) — adopt wholesale, same as a snapshot would
          return { settings: msg.settings };
      }
    }),

  applyMenu: (command) => {
    const s = get();
    switch (command.id) {
      case "about":
        s.setInfoOpen(true);
        break;
      case "palette":
        s.setPaletteOpen(!s.paletteOpen);
        break;
      case "shortcuts":
        s.setShortcutsOpen(!s.shortcutsOpen);
        break;
      case "displayMode":
        s.setDisplayMode(!s.displayMode);
        break;
      case "toggleNav":
        // Same round-trip as Nav's collapse button: persist, then adopt.
        void tt
          .setSettings({ navCollapsed: !s.settings.navCollapsed })
          .then((next) => get().setSettings(next));
        break;
      case "screen":
        s.setScreen(command.screen as Screen);
        break;
      case "navBack":
        s.goBack();
        break;
      case "navForward":
        s.goForward();
        break;
    }
  },
}));
