import type { QueueListItem } from "./smoip";

/**
 * CONTROLS ON THE OTHER SCREENS (0.17.0, Display on other screens): what a screen may ask of the
 * streamer, and what it is told it may do. Shared by the display server (main/servers/
 * displayServer, the one write route) and the page (display/PageTransport).
 *
 * - A FIXED LIST OF VERBS, the system's media commands (shared/transport MediaCommand) with a
 *   seek to a point in the playing track (step four, its seconds), a volume step up or down,
 *   playing a track already in the queue (the queue view, step two: view and select), and with
 *   their own switch the controls that start music (step three): a preset, Wake, picking up where
 *   it left off. Nothing else is reachable: no level, no queue or preset edits, no settings.
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
  "wake",
  "resume",
] as const;
export type DisplayVerb = (typeof DISPLAY_VERBS)[number];

export const isDisplayVerb = (v: unknown): v is DisplayVerb =>
  typeof v === "string" && (DISPLAY_VERBS as readonly string[]).includes(v);

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
  /** The presets, for a screen allowed to control with Presets and wake on; null otherwise. */
  presets: DisplayPresetRow[] | null;
  /** With Presets and wake on, while the streamer isn't playing for the page: "ready", the app is
   *  connected to a streamer in standby, so Wake works; "unreachable", the app isn't connected (in
   *  Cambridge's default Eco standby the streamer leaves the network), so the screen says so and
   *  draws no button that does nothing; null otherwise. */
  wake: "ready" | "unreachable" | null;
  /** What TastyTunes holds to pick up where it left off (with Presets and wake on), or null. */
  resume: { title: string; detail: string | null } | null;
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

/** The rows sent around the playing track: a few before it, about fifty after. A queue can run to
 *  thousands, and a screen needs what is coming, not the whole evening at once. */
export const QUEUE_BEFORE = 3;
export const QUEUE_AFTER = 50;

/** The window of the queue a screen is sent, around `playId` (from the start without one). */
export function queueWindow(
  items: readonly QueueListItem[],
  playId: number | null,
): DisplayQueueRow[] {
  const at = playId == null ? -1 : items.findIndex((i) => i.id === playId);
  const from = Math.max(0, at - QUEUE_BEFORE);
  const to = Math.min(items.length, Math.max(at, 0) + QUEUE_AFTER + 1);
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
