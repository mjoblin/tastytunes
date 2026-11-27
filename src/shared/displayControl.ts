import {
  canSleepAtTrackEnd,
  SLEEP_DURATIONS,
  sleepActionOf,
  sleepTimerFor,
  type SleepAction,
  type SleepTimer,
} from "./model";
import type { QueueListItem, ZoneNowPlaying, ZonePlayState } from "./smoip";

/**
 * CONTROLS ON THE OTHER SCREENS (0.17.0, Display on other screens): what a screen may ask of the
 * streamer, and what it is told it may do. Shared by the display server (main/servers/
 * displayServer, the one write route) and the page (display/PageTransport).
 *
 * - A FIXED LIST OF VERBS, the system's media commands (shared/transport MediaCommand) with a
 *   seek to a point in the playing track (step four, its seconds), a volume step up or down,
 *   playing a track already in the queue (the queue view, step two: view and select), and with
 *   their own switch the controls that start music (step three): a preset, one of the app's
 *   playlists (and stopping one on its way into the queue), Wake, picking up where it left off;
 *   and under that switch, standby and the app's own sleep timer (one of the window's lengths or
 *   the end of the track, the action and the fade the app's own settings).
 *   Nothing else is reachable: no level, no queue, preset or playlist edits, no settings.
 * - Each screen is told where it stands (DisplayControl), over its own line of the live channel,
 *   so it draws only what it may do.
 */

/** What a screen may ask for. Play and pause are a TV remote's own keys; the buttons send toggle. */
export const DISPLAY_VERBS = [
  "toggle",
  "play",
  "pause",
  "next",
  "previous",
  "stop",
  "seek",
  "volumeUp",
  "volumeDown",
  "playQueue",
  "playPreset",
  "playPlaylist",
  "stopPlaylist",
  "wake",
  "resume",
  "standby",
  "sleep",
  "sleepCancel",
] as const;
export type DisplayVerb = (typeof DISPLAY_VERBS)[number];

export const isDisplayVerb = (v: unknown): v is DisplayVerb =>
  typeof v === "string" && (DISPLAY_VERBS as readonly string[]).includes(v);

/** What a verb carries, past the route's checks: `id`, the queue row or the preset (a whole
 *  number); `secs`, where a seek goes; `playlist`, the playlist's own id; `minutes`, the sleep
 *  timer's length. */
export interface DisplayVerbArgs {
  id?: number;
  secs?: number;
  playlist?: string;
  minutes?: SleepChoice;
}

/** A sleep timer's length as a screen may ask for it: one of the window's (SLEEP_DURATIONS), in
 *  minutes, or "track" for the end of the playing track. */
export type SleepChoice = number | "track";

export const isSleepChoice = (v: unknown): v is SleepChoice =>
  v === "track" || (typeof v === "number" && SLEEP_DURATIONS.some((d) => d.minutes === v));

/** A playlist's id as a screen may send it: the app's own (a UUID), letters, digits and dashes. */
export const isPlaylistId = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9A-Za-z-]{1,64}$/.test(v);

/**
 * Where a screen stands:
 * - off: the app's switch is off, so no screen has buttons;
 * - ask: its first tap asks in the app;
 * - asking: the app is asking ("Allow this screen to control playback?");
 * - declined: "Not now", and it doesn't ask again for a while (Settings can still allow it);
 * - allowed.
 */
export type DisplayControlState = "off" | "ask" | "asking" | "declined" | "allowed";

export interface DisplayControl {
  state: DisplayControlState;
  /** The streamer's volume, for a screen allowed to change it, where there is one to change (an
   *  absolute level in Pre-Amp mode, steps alone on Control Bus); null otherwise. */
  volume: { percent: number | null; step: number | null } | null;
  /** The next track in the queue, by name, for a screen allowed to control; null otherwise or
   *  when the queue doesn't know it. */
  next: { title: string; artist: string | null } | null;
  /** The queue around the playing track (queueWindow), for a screen allowed to control while the
   *  queue is what plays; null otherwise. Pictures by the display server's id, never by address. */
  queue: DisplayQueueRow[] | null;
  /** The presets, for a screen allowed to control with Presets, playlists and power on; null otherwise. */
  presets: DisplayPresetRow[] | null;
  /** The app's playlists, under the same switch, while the streamer is on (loading one doesn't
   *  wake it); null otherwise. */
  playlists: DisplayPlaylistRow[] | null;
  /** With Presets, playlists and power on, while the streamer isn't playing for the page: "ready", the app is
   *  connected to a streamer in standby, so Wake works; "unreachable", the app isn't connected (in
   *  Cambridge's default Eco standby the streamer leaves the network), so the screen says so and
   *  draws no button that does nothing; null otherwise. */
  wake: "ready" | "unreachable" | null;
  /** What TastyTunes holds to pick up where it left off (with Presets, playlists and power on), or null. */
  resume: { title: string; detail: string | null } | null;
  /** With Presets, playlists and power on, while the streamer is connected and on: standby, which
   *  the page sends only for a press held long enough (display/PageTransport). */
  standby: boolean;
  /** The app's sleep timer, under the same switch and while the streamer is on; null otherwise. */
  sleep: DisplaySleep | null;
  /** This screen's short code (screenCode), which the page shows while it asks; absent before the
   *  page has heard its first line, and for a screen without an id. */
  code?: string | null;
  /** The app's clock as the line went out (ms since the epoch): the page counts the sleep timer's
   *  time left from it, since a TV's or an old tablet's own clock can be minutes off. Added as the
   *  line is written (servers/displayFeed clockedLine), never part of what a screen is told again
   *  for, and absent on a line the page made for itself. */
  now?: number;
}

/** The app's sleep timer as a screen sees it: set and cancelled from there, its action and its
 *  fade only ever the app's own settings. */
export interface DisplaySleep {
  /** What happens when it runs out: the armed timer's own, else the app's setting (sleepAction). */
  action: SleepAction;
  /** "End of track" is offered (the window's rule, shared/model canSleepAtTrackEnd). */
  endOfTrack: boolean;
  /** Armed: when it runs out (ms since the epoch, by the app's clock), or null for the end of the
   *  track; null when it isn't armed. */
  armed: { firesAt: number | null } | null;
}

/** One preset as a screen sees it: view and select, nothing edited. */
export interface DisplayPresetRow {
  /** Its slot: the only thing a screen sends back (playPreset). */
  id: number;
  name: string;
  art: string | null;
  /** Playing now (shared/litPresets, the window's own rule). */
  lit: boolean;
  /** Its last recall came to nothing (main/device/recallWatch). */
  dead: boolean;
}

/** One of the app's playlists as a screen sees it: view and select, nothing edited. */
export interface DisplayPlaylistRow {
  /** Its id: the only thing a screen sends back (playPlaylist). */
  id: string;
  name: string;
  /** Its first picture (the menu bar panel's row), by the display server's id on the wire. */
  art: string | null;
  tracks: number;
  /** Its running time, where its tracks know theirs; null otherwise. */
  secs: number | null;
  /** On its way into the queue (the app loads a playlist a track at a time), how far. */
  loading: { done: number; total: number } | null;
}

/** One track of the queue as a screen sees it. */
export interface DisplayQueueRow {
  /** The streamer's queue id: the only thing a screen sends back (playQueue). */
  id: number;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  art: string | null;
  playing: boolean;
}

/** A queue this long or shorter goes to a screen whole (an album, a playlist, an evening's
 *  worth): a window of a few rows before the playing track left a screen near an album's end
 *  with four rows and nothing to scroll back to. */
export const QUEUE_ALL = 300;
/** A longer one (a whole library played, thousands of tracks) goes as a window around the playing
 *  track: this many before it and after. A screen hears its line again only when it changes. */
export const QUEUE_BEFORE = 100;
export const QUEUE_AFTER = 200;
/** The streamer's preset slots (1 to 99): every preset goes to a screen. */
export const PRESETS_MAX = 99;
/** The playlists a screen is sent, at most (the app's own, in their order). */
export const PLAYLISTS_SENT = 200;
/** The most pictures one control line can name: the queue's rows, every preset, the playlists. The
 *  display server keeps its picture ids by this (servers/displayServer MAX_ART_IDS): a cap of its
 *  own (200) once fell under a whole queue's 300 rows and dropped covers a screen still showed. */
export const LINE_PICTURES_MAX =
  Math.max(QUEUE_ALL, QUEUE_BEFORE + 1 + QUEUE_AFTER) + PRESETS_MAX + PLAYLISTS_SENT;

/** The queue a screen is sent: whole up to QUEUE_ALL, else the window around `playId` (from the
 *  start without one). */
export function queueWindow(
  items: readonly QueueListItem[],
  playId: number | null,
): DisplayQueueRow[] {
  const at = playId == null ? -1 : items.findIndex((i) => i.id === playId);
  const whole = items.length <= QUEUE_ALL;
  const from = whole ? 0 : Math.max(0, at - QUEUE_BEFORE);
  const to = whole ? items.length : Math.min(items.length, Math.max(at, 0) + QUEUE_AFTER + 1);
  const rows: DisplayQueueRow[] = [];
  for (const item of items.slice(from, to)) {
    if (item.id == null) continue;
    const md = item.metadata;
    rows.push({
      id: item.id,
      title: md?.title ?? md?.name ?? "—",
      artist: md?.artist ?? null,
      album: md?.album ?? null,
      duration: md?.duration ?? null,
      art: md?.art_url ?? null,
      playing: item.id === playId,
    });
  }
  return rows;
}

/** What the app knows when a screen asks for standby or the sleep timer. */
export interface PowerFacts {
  /** The app is connected to the streamer and it is on. */
  on: boolean;
  /** The app's sleep action as stored (settings.sleepAction). */
  action: unknown;
  playState: ZonePlayState | null;
  nowPlaying: ZoneNowPlaying | null;
  /** The sleep timer as armed now, or null. */
  timer: SleepTimer | null;
}

/** Standby and the sleep timer as a screen with Presets, playlists and power is told of them: both
 *  offered while the streamer is on (a sleeping one has Wake instead), the timer as it stands. */
export function powerLine(f: PowerFacts): Pick<DisplayControl, "standby" | "sleep"> {
  if (!f.on) return { standby: false, sleep: null };
  return {
    standby: true,
    sleep: {
      action: f.timer?.action ?? sleepActionOf(f.action),
      endOfTrack: canSleepAtTrackEnd(f.playState, f.nowPlaying),
      armed: f.timer ? { firesAt: f.timer.firesAt } : null,
    },
  };
}

/** What a screen's standby or sleep timer verb comes to: standby, a timer armed (the app's own
 *  action, as the window arms it) or cancelled, or null with nothing to do (the streamer not on,
 *  the end of a track where none is offered, no timer to cancel). */
export function powerVerb(
  verb: "standby" | "sleep" | "sleepCancel",
  minutes: SleepChoice | undefined,
  f: PowerFacts,
  now: number,
): { standby: true } | { sleep: SleepTimer | null } | null {
  if (verb === "sleepCancel") return f.timer ? { sleep: null } : null;
  if (!f.on) return null;
  if (verb === "standby") return { standby: true };
  if (minutes == null || !isSleepChoice(minutes)) return null;
  if (minutes === "track" && !canSleepAtTrackEnd(f.playState, f.nowPlaying)) return null;
  return { sleep: sleepTimerFor(minutes, sleepActionOf(f.action), f.playState, now) };
}

/** What the route answers: done, or why not. */
export type DisplayControlAnswer =
  { done: true } | { refused: DisplayControlState | "busy" | "nothing" | "volume" | "presets" };

/** A screen as Settings lists it, and as the app asks about it. */
export interface DisplayScreen {
  /** The browser's own id (the tt_screen cookie). */
  id: string;
  /** Its device and browser ("iPad · Safari"). */
  name: string;
  /** When it first asked, ms since the epoch. */
  firstSeen: number;
  allowed: boolean;
}

export interface DisplayScreens {
  screens: DisplayScreen[];
  /** The screen the app is asking about now, oldest first; null when none asks. */
  asking: DisplayScreen | null;
}

/**
 * A screen's short code: three digits from its id, the same each time. The page shows it while the
 * screen asks, and the app's prompt and Settings' list show it beside the name, so two screens of
 * one kind (two iPads in Safari) can be told apart. A check by eye, not a secret, and not unique.
 */
export function screenCode(id: string): string {
  const n = Number.parseInt(id.slice(0, 8), 16);
  return String(Number.isFinite(n) ? n % 1000 : 0).padStart(3, "0");
}

/** A device's kind by its browser's own words, the first that matches. */
const DEVICES: Array<[RegExp, string]> = [
  [/iPad/, "iPad"],
  [/iPhone/, "iPhone"],
  [/SMART-TV|SmartTV|Tizen|Web0S|webOS|NetCast|BRAVIA|AFT[A-Z]|CrKey|GoogleTV|Android TV/i, "TV"],
  [/Android.*Mobile/, "Android phone"],
  [/Android/, "Android tablet"],
  [/CrOS/, "Chromebook"],
  [/Macintosh/, "Mac"],
  [/Windows/, "Windows PC"],
  [/Linux/, "Linux computer"],
];
/** A browser by its own words, the first that matches (the ones built on Chrome or Safari name
 *  themselves before the engine they are built on). */
const BROWSERS: Array<[RegExp, string]> = [
  [/DuckDuckGo|Ddg\//, "DuckDuckGo"],
  [/SamsungBrowser/, "Samsung Internet"],
  [/Silk\//, "Silk"],
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Vivaldi/, "Vivaldi"],
  [/Firefox\/|FxiOS/, "Firefox"],
  [/Chrome\/|CriOS|Chromium/, "Chrome"],
  [/Safari\//, "Safari"],
];

/**
 * A screen's name from its browser: its device's kind and the browser's name, enough to tell the
 * iPad from the TV. An iPad's Safari says it is a Mac unless asked otherwise, so the page says
 * whether it has a touch screen (`touch`). A name is only a label: a page can say anything.
 */
export function screenName(userAgent: string, touch = false): string {
  let device = DEVICES.find(([re]) => re.test(userAgent))?.[1] ?? "Screen";
  if (device === "Mac" && touch) device = "iPad";
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  return browser ? `${device} · ${browser}` : device;
}
