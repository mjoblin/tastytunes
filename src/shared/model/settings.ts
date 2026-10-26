// The persisted settings (AppSettings) and their defaults: the domain par excellence. Read
// defaults from DEFAULT_SETTINGS, never restate them.

import type { McpSettings } from "./mcp";
import type { Schedule, SleepAction } from "./schedules";

// ---------------------------------------------------------------------- settings

export type Theme = "dark" | "light";
/** Stored preference: an explicit theme, or follow the OS. */
export type ThemePreference = Theme | "system";

/** The display face ("money font") — a curated, bundled set. The array is the
 *  single source of truth for valid ids (persist.ts coerces unknown values to
 *  the default; the renderer builds its labelled picker from the same ids). */
export const DISPLAY_FONT_IDS = [
  "fraunces",
  "unbounded",
  "newsreader",
  "hanken",
  "instrument-serif",
  "schibsted",
  "instrument-sans",
] as const;
export type DisplayFont = (typeof DISPLAY_FONT_IDS)[number];
/** Display mode's SCENE: what fills the screen (0.8.0). Sleeve is the art
 *  face; most of the rest are abstract scenes drawn from the track's feature
 *  strip and its timed lyrics; Hi-Fi and Turntable draw the player itself
 *  and need no analysis, so they draw for any source (0.10.0); shuffle draws a
 *  fresh scene each track. */
export const DISPLAY_SCENE_IDS = [
  "sleeve",
  "tide",
  "terrain",
  "orbit",
  "type",
  "survey",
  "conduit",
  "confluence",
  "pit",
  "roll",
  "sea",
  "terminal",
  "refrain",
  "panel",
  "turntable",
  "shuffle",
] as const;
export type DisplayScene = (typeof DISPLAY_SCENE_IDS)[number];
/** A scene's declared setting value (slider, toggle or select). */
export type SceneSettingValue = number | boolean | string;
/** How a collection screen lays out its items. */
export type ScreenLayout = "rows" | "cards";
/** The queue alone adds an album-grouped reading view (cover once, tracks beneath). */
export type QueueLayout = ScreenLayout | "albums";
/** Motion effects: follow the OS Reduce Motion setting, or force on/off. */
export type MotionMode = "system" | "on" | "off";
export type AmbientArtMode = "off" | "now-playing" | "all";
export type AmbientCoverage = "main" | "window";
export type AlignH = "left" | "center" | "right";
export type AlignV = "top" | "center" | "bottom";

/**
 * A streamer this app has actually connected to — the device book behind
 * multi-streamer households. Keyed by UDN (identity), because the ADDRESS is
 * only a hint: every sweep or connect that sees the device again refreshes
 * `host` and `lastSeenAt` in place, so a DHCP reassignment self-heals. The
 * book never ages by clock — a summer-house streamer seen twice a year is
 * exactly what it exists to remember; the only exits are the LRU cap and the
 * user's explicit Forget.
 */
export interface KnownDevice {
  udn: string;
  host: string;
  friendlyName: string;
  model: string;
  lastSeenAt: number;
}

/** LRU cap on the device book — nobody owns eight streamers; churners get
 *  least-recently-seen eviction for free. */
export const KNOWN_DEVICES_MAX = 8;

/**
 * How long a failing reconnect keeps the benefit of the doubt. Under this,
 * the loss reads as a blip (Wi-Fi hiccup, reboot) and the app just retries;
 * past it, the device is treated as GONE — the connect gate un-walls into
 * the full surface and the single-candidate auto-connect may act. Eco
 * standby powers the network interface down, so an eco-configured device
 * skips the doubt entirely at the gate.
 */
export const RECONNECT_GRACE_MS = 15_000;

export interface AppSettings {
  lastHost: string | null;
  /** Every streamer ever connected — see KnownDevice. */
  knownDevices: KnownDevice[];
  mediaKeys: boolean;
  volumeLimitPercent: number | null;
  notifications: boolean;
  /**
   * A TastyTunes icon in the system tray / menu bar, with a context menu that
   * reaches the streamer without opening a window. Companion to the main
   * window, never a replacement — see main/app/tray.ts.
   *
   * Default OFF, and deliberately a knob rather than a heuristic (the usual
   * "a better default beats a new knob" rule was checked): a permanent icon in
   * someone's menu bar has no defensible default and, unlike a toast, can't be
   * discovered and dismissed.
   */
  tray: boolean;
  /**
   * The "TastyTunes is still running" notice has been shown once. Internal
   * one-shot state, not a preference — there is no UI for it. Closing the last
   * window with a tray icon present leaves the app alive, and silently
   * surviving a close is how apps earn a reputation for being un-quittable.
   */
  trayCloseNoticeShown: boolean;
  /** The one-time line on Now Playing pointing to Fullscreen Display mode has been dismissed,
   *  or Display mode opened (0.10.0, the first five minutes). Internal one-shot state, not a
   *  preference: there is no row for it. */
  displayHintSeen: boolean;
  /** The held state (HeldState.at) whose offer on the standby face was dismissed: that
   *  standby's offer stays away across restarts, and the next standby brings a new one.
   *  Internal state, not a preference: there is no row for it. */
  resumeDismissedAt: number | null;
  theme: ThemePreference;
  displayFont: DisplayFont;
  /** Blurred album-art backdrop. */
  ambientArt: AmbientArtMode;
  /** Backdrop extent: the main content area, or the whole window (nav + bar too). */
  ambientCoverage: AmbientCoverage;
  vignette: boolean;
  accentFollowsArt: boolean;
  /** Preset grid: base card width in px. */
  presetCardSize: number;
  /** Preset grid: gap between cards in px. */
  presetGap: number;
  /** Preset grid: stretch cards to fill each row (true) or keep them exact-size (false). */
  presetFillRows: boolean;
  /** Now Playing content placement. */
  nowPlayingAlignH: AlignH;
  nowPlayingAlignV: AlignV;
  /** Left nav reduced to icons only. */
  navCollapsed: boolean;
  /**
   * Screens hidden from the left nav. A hide-set (not a visible-list) so
   * screens added in future app versions default to visible. Persisted as
   * plain ids; the renderer sanitizes on use (drops unknown ids, never hides
   * 'now-playing'). Nav-only — hidden screens stay fully reachable via their
   * keyboard shortcut and the command palette.
   */
  navHidden: string[];
  /**
   * Nav tools hidden from the left nav's pinned bottom cluster (Commands,
   * Mini player). A hide-set (not a visible-list) so tools added in future app
   * versions default to visible. Persisted as plain ids; the renderer sanitizes
   * on use (drops unknown ids). Separate from navHidden — tool ids and screen
   * ids are different id-spaces. Nav-only: Commands stays on the palette
   * shortcut, the mini player stays in the palette and the View menu.
   */
  navHiddenTools: string[];
  /**
   * The user's own nav-rail order — screen ids, top to bottom. `[]` means the
   * registry's curated default, which is what almost everyone keeps.
   *
   * An ORDER, unlike navHidden's hide-set, can't default-by-omission, so the
   * sanitizer carries the rule instead: an id missing from a stored order is
   * inserted at its REGISTRY position, never appended. That is what stops a
   * screen added in a future version from landing below Device for everyone
   * who has ever touched this list. Hidden screens keep their slot here —
   * hidden means decluttered, not deleted, and unhiding restores position.
   *
   * Nav-rail screens only: the pinned bottom cluster (Commands, Mini player,
   * Settings) is fixed. KEYS DO NOT TRAVEL WITH POSITION — see the registry
   * header in lib/screens.ts.
   */
  navOrder: string[];
  /** Auto-scroll to the current queue row / playing preset. */
  followQueue: boolean;
  followPresets: boolean;
  /** Per-screen cards ⇄ rows layout. Card sizing shares the presetCard* settings. */
  queueLayout: QueueLayout;
  presetsLayout: ScreenLayout;
  libraryLayout: ScreenLayout;
  /** Album-grid sort in the Library (tracks always sort by track number). */
  librarySort: "server" | "title" | "artist" | "year";
  librarySortReversed: boolean;
  /**
   * VIEW DEFAULTS PERSIST (ruled 2026-08-06): a control that shapes how a
   * screen presents — sort, partition, layout, a hide-this-kind toggle — is
   * the user naming their preferred default view, so it lives here. What
   * stays session-only is workspace state: filter text, selections, scroll,
   * queries. The five below joined under that ruling; anything similar added
   * later belongs here too.
   */
  /** Albums lens sort (the native album grid above keeps librarySort). */
  lensAlbumsSort:
    | "title"
    | "artist"
    | "added"
    | "year"
    | "dr"
    | "loudness"
    | "lastPlayed"
    | "plays"
    | "wholeListens";
  lensAlbumsSortReversed: boolean;
  /** Artists lens: hide artists that only have loose tracks. */
  lensArtistsAlbumsOnly: boolean;
  /** Artists lens sort (0.13.0 round 12, the third way the lenses differed): by name with the
   *  A-Z rail, the most played first, or the newest arrival first (an artist's newest album). */
  lensArtistsSort: "name" | "plays" | "added";
  lensArtistsSortReversed: boolean;
  /** The artist page's album order (0.13.0-rc.4, a user's question: the page's order, newest
   *  first, was hidden behind the year each card cut off): by year, newest first, or by title. */
  artistPageSort: "year" | "title";
  artistPageSortReversed: boolean;
  /** Albums lens partition: everything, artist albums only, or compilations only. */
  lensAlbumsKind: "all" | "albums" | "compilations";
  /** Tracks lens sort — the third lens (2026-09-01), every track across the
   *  ready indexes; DR sorts newest-analysis-first once the sweep has run. */
  lensTracksSort:
    | "title"
    | "artist"
    | "album"
    | "year"
    | "duration"
    | "dr"
    | "loudness"
    | "tempo"
    | "lastPlayed"
    | "plays";
  lensTracksSortReversed: boolean;
  playlistsSort: "updated" | "created" | "played" | "name" | "length";
  playlistsSortReversed: boolean;
  /** Favorites kind partition (All / Stations / Albums / Tracks). */
  favoritesKind: "all" | "station" | "album" | "track";
  searchSort: "relevance" | "name";
  searchSortReversed: boolean;
  /**
   * Unified search: hidden result categories, plain ids sanitized on use
   * (the navHidden pattern). null = never customized — the screen derives
   * the default from navHidden (a screen hidden from the rail starts hidden
   * in search); an array is the user's explicit chip choice and wins.
   */
  searchHidden: string[] | null;
  /** Remembered sleep-timer action (pause vs standby). The countdown itself is not persisted. */
  sleepAction: SleepAction;
  /** Recently Played: collapse continuous sessions (radio/AirPlay/…) to one row, vs a row per song. */
  recentsGrouped: boolean;
  /** The History screen's section (0.8.0): the device log, or the record's Timeline. */
  historyView: "recent" | "timeline" | "stats" | "rediscover" | "elsewhere";
  /** The Timeline's unit (0.8.0): sessions collapsed to a line each, or every play. */
  historyTimelineMode: "sessions" | "plays";
  /** Motion effects (hover growth, eqbars, smooth scrolling). */
  motion: MotionMode;
  /** Check GitHub releases for a newer version on launch and every few hours. */
  updateCheck: boolean;
  /** Lyrics panel on Now Playing — fetches from LRCLIB on demand when opened. */
  /**
   * Waveforms drawn from each track's audio file, read from the local media
   * server (EXPERIMENT, 0.7 exploration). The master is the fetch off-switch;
   * the seek-bar sub-toggle exists because restyling permanent chrome is a
   * different question from wanting waveform information (the tray-icon
   * precedent); displayWaveform is display mode's own in-mode button.
   */
  waveforms: boolean;
  waveformSeekBar: boolean;
  waveformNowPlaying: boolean;
  displayWaveform: boolean;
  /** What the Now Playing hero's art box shows: Sleeve is the art (the
   *  default), any other id a display-mode scene run small in its place
   *  while an analyzed track plays. Chosen from the tile, never Settings;
   *  remembered apart from the fullscreen view's displayScene. */
  nowPlayingScene: DisplayScene;
  /** The scenes' words in the Now Playing tile, as on the wall. Off by default: the lyric
   *  line beside the art already carries them, and a third copy in a smaller face beside
   *  the app's own is the redundancy the tile avoids. A fact about the host, not a scene,
   *  so one switch of the tile's, the scenes' own Words settings staying the wall's. */
  nowPlayingSceneWords: boolean;
  /** The Now Playing art's size, dragged from the box's corner, as a SHARE of the room it
   *  has (the smaller of the hero's height less the waveform under it, and its width less
   *  the text column's), so a size dragged on a large monitor still fits a small window.
   *  Null is the automatic size: three tiers by window width, and the detent the drag
   *  snaps back to. */
  nowPlayingArtShare: number | null;
  /** The picture's size in the Library's album and artist headers, dragged from its corner
   *  (0.11.0, his ask after the artist page): one size for both, so moving between an artist
   *  and their albums keeps the picture still, and apart from Now Playing's, whose room is the
   *  whole hero (a fit, not a preference). Pixels, clamped at draw time to the header's cap, so
   *  a size dragged on a large monitor comes back there and still fits a small window. Null is
   *  the default size, the detent the drag snaps back to. */
  libraryHeaderArt: number | null;
  /** EVIDENCE, not preference: flips true the first time an analysis is
   *  served (stored or read back) and never clears. The playback bar's
   *  taller geometry keys on the setting AND this — a household with no
   *  local media server never pays 16px for a waveform it can't have. A
   *  settings flag rather than a cache probe, so Clear cached lookups
   *  can't shrink the bar. */
  waveformSeen: boolean;
  lyrics: boolean;
  /** Inline flavor: current synced line under the Now Playing track details. */
  lyricsLine: boolean;
  /** Current synced line in full-screen display mode (toggled from its chrome). */
  displayLyrics: boolean;
  /** Display mode's scene (its in-mode picker, Tab cycles). */
  displayScene: DisplayScene;
  /** Each scene's own settings, by scene id, over the scene's declared defaults. */
  displaySceneSettings: Record<string, Record<string, SceneSettingValue>>;
  /** Display mode's sync nudge in ms, added to the shown clock: the streamer reports its
   *  position about once a second and the pipeline has its own latency, so the scenes'
   *  hits and words may sit a constant offset from what is heard. In-mode, remembered. */
  displaySyncMs: number;
  /** How much lull a DROP needs (lib/features DROP_TIERS): loose, normal (three seconds of
   *  chill or one of near silence), strict. Taste and genre, so it is in-mode. */
  displayDrops: "loose" | "normal" | "strict";
  /** A finish over every display-mode scene: plain, or a cathode glass (scanlines, a slight
   *  curve, phosphor glow, a vignette). Taste, so it is in-mode; never on the picker's tiles.
   *  Cathode by default (user, 2026-09-07). */
  displayFinish: "plain" | "cathode";
  /** The Cathode glass: how much the picture bows (deep is about twice a real tube, gentle
   *  about life), and whether it overscans so the picture meets the frame at the edges and
   *  only the corners fall behind the glass. In-mode, beside Finish. */
  displayCathodeCurve: "gentle" | "deep";
  displayCathodeFill: boolean;
  /** The wall's corners (2026-09-15, user: they can "kill the mood of a fullscreen display"):
   *  the track's name at the bottom left and the time at the bottom right, each its own
   *  switch, on by default; a shelf display often wants the clock without the title. In-mode,
   *  beside Finish. The tile has no corners. */
  displayCornerTitle: boolean;
  displayCornerClock: boolean;
  /** The glass's flicker (2026-09-15, user: an accessibility concern): the cathode finish
   *  breathes a mains hum into the brightness at ten hertz, three percent either way, which
   *  sits in the band photosensitive people are warned about; its own switch, on by default,
   *  off already under the system's reduced-motion setting. In-mode, in the Finish row. */
  displayCathodeFlicker: boolean;
  /** Shuffle: the order it walks the scenes (sequential is the picker's alphabetical order,
   *  random, the default, never repeats the one before), how many tracks each scene stays for ("album"
   *  changes when the album does), and the scenes left out of the rotation, by id (the sleeve
   *  is out unless asked in). In-mode, on the Shuffle tile. */
  displayShuffleOrder: "sequential" | "random";
  displayShuffleEvery: 1 | 2 | 3 | "album";
  displayShuffleExclude: string[];
  /** The listening record: a local, append-only play log (history/<year>.jsonl
   *  in userData). On by default — a diary can't be backfilled. */
  listeningRecord: boolean;
  /** The record's READING surfaces (0.8.0): last played in album headers, play
   *  counts and the Played filter in the Library, the resume offer on Now
   *  Playing. Off hides them all; the record itself keeps logging. */
  showListeningHistory: boolean;
  /** The Recent list (the History screen's Recent view, the tray panel's Recent tab): the
   *  last tracks and stations played, a local log SEPARATE from the listening record. It had
   *  no switch of its own and its only control sat under Behavior as "Recently played"
   *  (the terminology pass, 2026-09-17); now it lives beside the record and can be stopped. */
  recents: boolean;
  /** Album art from the audio files themselves (0.8.0): when a media server
   *  sends small artwork, the full picture is read from the file's own tags for
   *  the big surfaces. Reads from the media server over the local network. */
  artFromFiles: boolean;
  /** Scrobble listens to ListenBrainz (needs a user token; radio is never scrobbled). The token,
   *  from listenbrainz.org/settings, is the secrets store's lbToken since 0.13.0, never here. */
  lbEnabled: boolean;
  /** Artist bio panel on Now Playing (MusicBrainz + Wikipedia, on demand). */
  artistInfo: boolean;
  /** Fill covers the media server doesn't have (MusicBrainz identifies the
   *  album, the Cover Art Archive supplies the image). Its own switch,
   *  independent of the context panel — the user's call, 2026-08-24. */
  albumArtLookup: boolean;
  /**
   * Look stations up in the radio-browser.info directory. OFF means the app
   * never contacts it — not from the Radio screen, not from unified search,
   * not from an agent. Favorited stations still play: a favorite carries its
   * own stream URL and needs no directory at all.
   */
  radioDirectory: boolean;
  /** Scheduled actions (alarms) — fire only while the app is running. */
  schedules: Schedule[];
  /** Countdown sleep timers ramp the volume down before firing (pre-amp mode only). */
  sleepFade: boolean;
  /**
   * Per-preset volume overrides (feature 10): recalling the preset through
   * TastyTunes also sets this volume. Keyed via presetVolumeKey (device udn +
   * preset id) so multi-streamer homes never cross-apply.
   */
  presetVolumes: Record<string, number>;
  /**
   * queueContentHash of the queue at save time for queue presets saved
   * through this app, keyed via presetVolumeKey(udn, slot). Lets the
   * Presets screen recognize a saved queue exactly (all tracks, in order)
   * even when the recall happened elsewhere or before this launch. Local to
   * this machine; presets saved by other controllers have no entry and fall
   * back to collage-fingerprint matching.
   */
  queueSignatures: Record<string, string>;
  /** MCP server for local AI agents. */
  mcp: McpSettings;
  /** Last-visited Settings tab (id from the Settings screen's tab rail). */
  /** Media indexes build/rebuild themselves (off = only from the Libraries buttons). */
  mediaIndexAuto: boolean;
  settingsTab: string;
  /**
   * Last-visited tray-panel tab. Remembered across opens on the same
   * precedent as `settingsTab` — you reach for the same one repeatedly, and
   * re-picking it every time is friction the panel can't afford at its size.
   *
   * Overridden by a heuristic, not a knob: opening on Queue with nothing
   * playing is an empty box, so an idle streamer opens on Presets.
   */
  trayTab: string;
  /**
   * Tray-panel list density: `detailed` carries album art and an artist line,
   * `compressed` is one line per row with no art — roughly double the rows in
   * the same space.
   *
   * WHY THIS IS SEPARATE FROM THE MAIN WINDOW'S LAYOUT SETTINGS, and the rule
   * for anything added later: **preferences travel between surfaces, fit does
   * not.** `followQueue` ("should the list chase the music?") is a preference —
   * it means the same thing in both places, so the panel honours the app's
   * setting rather than growing its own. Density is a question about how much
   * fits in a 380px window, which has no bearing on a 1180px one; sharing it
   * would force one answer onto two very different surfaces. The design
   * already applied this rule once, ruling that the panel must not inherit
   * `presetCardSize`/`presetGap`.
   */
  trayRowDensity: "detailed" | "compressed";
  /** Tray-panel presets: art tiles or rows. Separate from `presetsLayout` for
   *  the same reason as the density above — it's fit, not preference. */
  trayPresetsLayout: ScreenLayout;
  /** Last-selected diagnostics-drawer tab (smoip | requests). */
  diagnosticsTab: string;
  /** Height (px) of the diagnostics drawer, drag-resizable from its top edge. */
  diagnosticsHeight: number;
  /** Last-selected Device-screen tab (tabs appear only on tone-capable streamers). */
  deviceTab: "streamer" | "sources" | "tone";
  /** Width (px) of the Now Playing drawers (lyrics/artist), drag-resizable. */
  panelWidth: number;
  /** Remembered mini-player window position. */
  miniBounds: { x: number; y: number } | null;
  /** Remembered main-window bounds — reopened at this size/position. */
  mainBounds: { x: number; y: number; width: number; height: number } | null;
  /**
   * Artist per device preset, keyed by presetVolumeKey(udn, presetId) —
   * recorded when TastyTunes saves an album/track preset from the Library.
   * LOCAL-ONLY: /presets/list carries NO artist field and firmware-derived
   * names are just the album title, so this is what lets the Presets filter
   * match "iron" against an Iron Maiden album preset. Presets saved by other
   * controllers have no entry (nothing to record from). Same lifecycle trade
   * as presetVolumes: entries are keyed by slot and not remapped on
   * move/delete.
   */
  presetArtists: Record<string, string>;
  /**
   * Each media server's own Recently added list, as the reader set it (0.13.0 round 9): a
   * container chosen in the Library (a folder's ⋯, Use as Recently added), with the titles of
   * the folders down to it so an id the server re-mints is found again, or "off" (Settings ›
   * Libraries). A server absent here uses the list found by its name. Keyed by server udn.
   */
  recentlyAddedLists: Record<string, { id: string; title: string; titlePath: string[] } | "off">;
  /**
   * User-saved EQ gain-sets (7 gains, dB). LOCAL by design: the firmware has
   * no preset storage — the official app's EQ presets are client-side too
   * (confirmed on the wire: tapping/saving one produces zero device traffic),
   * so its presets and ours can't see each other. Applying = one multi-band
   * user_eq_bands frame.
   */
  eqPresets: Array<{ name: string; gains: number[] }>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  lastHost: null,
  knownDevices: [],
  mediaKeys: true,
  volumeLimitPercent: null,
  notifications: true,
  // ON by default (user call, 2026-08-03, once the panel feature-completed):
  // the panel is the app's reach-without-a-window face, and a default-off
  // switch buried mid-list meant most installs would never meet it. Existing
  // installs that TOUCHED the toggle keep their stored value; only settings
  // files without the key pick up the new default.
  tray: true,
  trayCloseNoticeShown: false,
  displayHintSeen: false,
  resumeDismissedAt: null,
  theme: "dark",
  displayFont: "fraunces",
  ambientArt: "all",
  ambientCoverage: "window",
  vignette: true,
  accentFollowsArt: false,
  presetCardSize: 160,
  presetGap: 12,
  presetFillRows: true,
  nowPlayingAlignH: "left",
  nowPlayingAlignV: "top",
  navCollapsed: false,
  navHidden: [],
  navHiddenTools: [],
  navOrder: [],
  followQueue: true,
  followPresets: false,
  queueLayout: "rows",
  presetsLayout: "cards",
  libraryLayout: "cards",
  librarySort: "server",
  librarySortReversed: false,
  lensAlbumsSort: "title",
  lensAlbumsSortReversed: false,
  lensArtistsAlbumsOnly: false,
  lensArtistsSort: "name",
  lensArtistsSortReversed: false,
  artistPageSort: "year",
  artistPageSortReversed: false,
  lensAlbumsKind: "all",
  lensTracksSort: "title",
  lensTracksSortReversed: false,
  playlistsSort: "updated",
  playlistsSortReversed: false,
  favoritesKind: "all",
  searchSort: "relevance",
  searchSortReversed: false,
  searchHidden: null,
  sleepAction: "standby",
  recentsGrouped: true,
  historyView: "recent",
  historyTimelineMode: "sessions",
  motion: "system",
  updateCheck: true,
  waveforms: true,
  waveformSeekBar: true,
  waveformNowPlaying: false,
  displayWaveform: true,
  nowPlayingScene: "sleeve",
  nowPlayingSceneWords: false,
  nowPlayingArtShare: null,
  libraryHeaderArt: null,
  waveformSeen: false,
  lyrics: true,
  lyricsLine: true,
  displayLyrics: true,
  displayScene: "sleeve",
  displaySceneSettings: {},
  displaySyncMs: 0,
  displayDrops: "normal",
  displayFinish: "cathode",
  displayCathodeCurve: "deep",
  displayCathodeFill: false,
  displayCornerTitle: true,
  displayCornerClock: true,
  displayCathodeFlicker: true,
  displayShuffleOrder: "random",
  displayShuffleEvery: 1,
  displayShuffleExclude: ["sleeve"],
  listeningRecord: true,
  showListeningHistory: true,
  recents: true,
  artFromFiles: true,
  lbEnabled: false,
  artistInfo: true,
  albumArtLookup: true,
  radioDirectory: true,
  schedules: [],
  sleepFade: true,
  presetVolumes: {},
  queueSignatures: {},
  mcp: {
    enabled: false,
    bind: "localhost",
    port: 8555,
    disabledClusters: [],
    enabledClusters: [],
    disabledTools: [],
  },
  mediaIndexAuto: true,
  settingsTab: "appearance",
  trayTab: "queue",
  // COMPRESSED by default (user call, 2026-08-03): the panel's job is a
  // glance's worth of list in a corner of the screen, and the flat rows fit
  // ~11 where the floating ones fit 6. The detailed skin stays one chip away.
  trayRowDensity: "compressed",
  trayPresetsLayout: "cards",
  diagnosticsTab: "smoip",
  diagnosticsHeight: 288,
  deviceTab: "streamer",
  panelWidth: 400,
  miniBounds: null,
  mainBounds: null,
  presetArtists: {},
  recentlyAddedLists: {},
  eqPresets: [],
};
