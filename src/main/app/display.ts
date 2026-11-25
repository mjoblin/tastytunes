import { join } from "node:path";
import { app } from "electron";
import {
  queueWindow,
  type DisplayControl,
  type DisplayControlAnswer,
  type DisplayScreen,
  type DisplayVerb,
} from "@shared/displayControl";
import type { DisplayStatus } from "@shared/ipc";
import type { AppSettings } from "@shared/model";
import { litPresetIds } from "@shared/litPresets";
import { activeSourceId, isCbusMode, isPreAmpMode } from "@shared/smoip";
import { commandForMedia, transportAbilities } from "@shared/transport";
import { jsonFileStore } from "../data/jsonStore";
import { artHostTrust, fetchPicture } from "../lookups/artFetch";
import { fetchLyrics } from "../lookups/lyrics";
import { audioAnalysisGet } from "../lookups/audioAnalysis";
import { lookupMediaInfo } from "../media/mediaInfo";
import { displayToken, getSettings, newDisplayToken } from "../data/persist";
import { DisplayServer } from "../servers/displayServer";
import { isStoredScreen, ScreenBook } from "../servers/displayScreens";
import { lanAddress } from "../servers/mcpServer";
import { alsoHearSettings, broadcastDisplayScreens, broadcastDisplayStatus } from "./broadcast";
import { connectedHost, deviceManager } from "./runtime";

/**
 * DISPLAY ON OTHER SCREENS, WIRED (0.17.0): the display server (servers/displayServer) follows its
 * switch in Settings › Integrations, answers from the app's own state, and serves the built page
 * (out/renderer/display.html). Settings shows the address it reports here: worked out each time
 * it is asked (the computer's address can change under a running server), and pushed to the
 * windows whenever the server starts, stops or fails.
 *
 * CONTROLS ON THE OTHER SCREENS: with its own switch on (displayControl, apart from viewing), a
 * screen the app has allowed (servers/displayScreens, kept in display-screens.json) may steer what
 * is playing. A verb goes the way the media keys go: commandForMedia against what the source can
 * do at that moment (a seek inside the track playing now), then deviceManager.fire; a volume step
 * with its own switch on, through the same command path and so under the one volume limit
 * (decisions/0017). Each in the log, with the screen's name.
 */

const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

const screensFile = jsonFileStore<DisplayScreen[]>({
  pathOf: () => join(app.getPath("userData"), "display-screens.json"),
  scope: "display screens",
  load: (parsed, setAside) => {
    if (parsed === undefined) return [];
    if (!Array.isArray(parsed)) {
      setAside.push("display screens: not a list");
      return [];
    }
    const kept = parsed.filter(isStoredScreen);
    if (kept.length < parsed.length)
      setAside.push(`display screens: ${parsed.length - kept.length} that couldn't be read`);
    return kept;
  },
});

/** The screens allowed to control, and the asks (servers/displayScreens). */
export const screenBook = new ScreenBook({
  load: () => screensFile.get(),
  save: (screens) => void screensFile.set(screens),
  now: () => Date.now(),
  changed: () => {
    broadcastDisplayScreens(screenBook.list());
    displayServer.pushControl();
  },
});

/** The streamer has a volume a screen could step: Pre-Amp mode's level, or Control Bus's steps
 *  (the window's own rule, playback/VolumeCluster). */
function volumeHere(): DisplayControl["volume"] {
  const z = deviceManager.streamerNow.zoneState;
  if (isPreAmpMode(z)) return { percent: z?.volume_percent ?? null, step: z?.volume_step ?? null };
  if (isCbusMode(z)) return { percent: null, step: null };
  return null;
}

/** Whether the queue is what plays (the media player): the only source with a queue to show. */
function queueAudible(): boolean {
  const s = deviceManager.streamerNow;
  return activeSourceId(s.zoneState, s.nowPlaying) === "MEDIA_PLAYER";
}

/** The queue's playing row: the streamer's pointer. */
const playingQueueId = (): number | null => {
  const s = deviceManager.streamerNow;
  return s.queue?.play_id ?? s.playState?.queue_id ?? null;
};

/** The next track by name, when the queue is what plays and knows it (not shuffled, not the last). */
function nextInQueue(): DisplayControl["next"] {
  const s = deviceManager.streamerNow;
  if (!queueAudible()) return null;
  if (s.playState?.mode_shuffle === "all") return null;
  const items = s.queue?.items ?? [];
  const at = playingQueueId();
  const i = at == null ? -1 : items.findIndex((it) => it.id === at);
  const md = i >= 0 ? items[i + 1]?.metadata : null;
  return md?.title ? { title: md.title, artist: md.artist ?? null } : null;
}

/** The queue around the playing track, while the queue is what plays and has anything in it. */
function queueHere(): DisplayControl["queue"] {
  const items = deviceManager.streamerNow.queue?.items ?? [];
  if (!queueAudible() || items.length === 0) return null;
  return queueWindow(items, playingQueueId());
}

/** The presets, each lit by the window's own rule (shared/litPresets). */
function presetsHere(): DisplayControl["presets"] {
  const v = deviceManager.streamerNow;
  const items = (v.presets?.presets ?? []).filter((p) => p.id != null);
  if (items.length === 0) return null;
  const r = deviceManager.recallsNow;
  const lit = litPresetIds(items, {
    zoneState: v.zoneState,
    nowPlaying: v.nowPlaying,
    playState: v.playState,
    queue: v.queue,
    systemInfo: v.systemInfo,
    systemPower: v.systemPower,
    waking: r.waking,
    lastRecalledPresetId: r.lastRecalled,
    deadPresets: r.dead,
    queueSignatures: getSettings().queueSignatures,
  });
  return items.map((p) => {
    const id = p.id as number;
    return {
      id,
      name: p.name ?? `Preset ${id}`,
      art: p.art_url ?? p.art_urls?.[0] ?? null,
      lit: lit.has(id),
      dead: r.dead.includes(id),
    };
  });
}

/** A wake can work: the app is connected to a streamer in standby. In Cambridge's default Eco
 *  standby the streamer leaves the network and the app isn't connected, so a screen says it
 *  can't reach it instead of drawing a button that does nothing. */
function wakeCanWork(): boolean {
  const power = deviceManager.streamerNow.systemPower?.power;
  return deviceManager.connectionNow.phase === "connected" && power != null && power !== "ON";
}

/** What TastyTunes holds to pick up where it left off, while the streamer sleeps: a queue's track
 *  or a station (another app's or an input is the window's to offer), unless it was dismissed. */
function resumeHere(): DisplayControl["resume"] {
  if (!wakeCanWork()) return null;
  const h = deviceManager.heldNow;
  if (!h || (h.kind !== "queue" && h.kind !== "radio")) return null;
  if (h.at === getSettings().resumeDismissedAt) return null;
  const title = h.title ?? h.sourceName;
  if (!title) return null;
  return { title, detail: h.kind === "queue" ? h.artist : h.sourceName };
}

/** Where a screen stands, and what it may see of the controls. */
function controlFor(screen: string | null): DisplayControl {
  const s = getSettings();
  const state = screenBook.stateOf(screen, s.displayControl);
  if (state !== "allowed")
    return {
      state,
      volume: null,
      next: null,
      queue: null,
      presets: null,
      wake: null,
      resume: null,
    };
  const starts = s.displayControlPresets;
  return {
    state,
    volume: s.displayControlVolume ? volumeHere() : null,
    next: nextInQueue(),
    queue: queueHere(),
    presets: starts ? presetsHere() : null,
    wake: !starts
      ? null
      : wakeCanWork()
        ? "ready"
        : deviceManager.connectionNow.phase !== "connected"
          ? "unreachable"
          : null,
    resume: starts ? resumeHere() : null,
  };
}

const log = (text: string): void => deviceManager.log("info", "display", text);

/** A screen's verb, past the route's checks. */
function steer(
  screen: string,
  name: string,
  verb: DisplayVerb,
  id?: number,
  secs?: number,
): DisplayControlAnswer {
  const s = getSettings();
  const state = screenBook.stateOf(screen, s.displayControl);
  if (state === "ask") {
    log(`${name} asks to control playback`);
    return { refused: screenBook.ask(screen, name, s.displayControl) };
  }
  if (state !== "allowed") return { refused: state };
  if (verb === "volumeUp" || verb === "volumeDown") {
    if (!s.displayControlVolume || volumeHere() == null) return { refused: "volume" };
    log(`volume ${verb === "volumeUp" ? "up" : "down"} from ${name}`);
    deviceManager.fire({ type: "volumeStepChange", delta: verb === "volumeUp" ? 1 : -1 });
    return { done: true };
  }
  // a track already in the queue, while the queue is what plays: view and select, nothing edited
  if (verb === "playQueue") {
    const there = (deviceManager.streamerNow.queue?.items ?? []).some((it) => it.id === id);
    log(
      `play queue row ${id} from ${name}: ${there && queueAudible() ? "playQueueId" : "nothing to do"}`,
    );
    if (id == null || !there || !queueAudible()) return { refused: "nothing" };
    deviceManager.fire({ type: "playQueueId", queueId: id });
    return { done: true };
  }
  // THE CONTROLS THAT START MUSIC (step three), with their own switch: a preset (a recall on a
  // sleeping streamer wakes it first, as in the window), Wake, picking up where it left off
  if (verb === "playPreset" || verb === "wake" || verb === "resume") {
    if (!s.displayControlPresets) return { refused: "presets" };
    if (verb === "playPreset") {
      const items = deviceManager.streamerNow.presets?.presets ?? [];
      const there = id != null && items.some((p) => p.id === id);
      log(`preset ${id} from ${name}: ${there ? "recallPreset" : "nothing to do"}`);
      if (!there || id == null) return { refused: "nothing" };
      const lit = presetsHere()?.find((p) => p.id === id)?.lit ?? false;
      deviceManager.fire({ type: "recallPreset", presetId: id, alreadyPlaying: lit });
      return { done: true };
    }
    if (verb === "wake") {
      log(`wake from ${name}: ${wakeCanWork() ? "power ON" : "nothing to do"}`);
      if (!wakeCanWork()) return { refused: "nothing" };
      deviceManager.fire({ type: "power", power: "ON" });
      return { done: true };
    }
    const held = resumeHere();
    log(`pick up where it left off from ${name}: ${held ? "resumeHeld" : "nothing to do"}`);
    if (!held) return { refused: "nothing" };
    deviceManager.fire({ type: "resumeHeld" });
    return { done: true };
  }
  const v = deviceManager.streamerNow;
  const duration = v.playState?.metadata?.duration ?? null;
  const can = transportAbilities(v.nowPlaying?.controls, duration);
  // a seek (step four) lands inside the track playing now, whatever the page last heard of it;
  // commandForMedia refuses it where the source can't seek
  const to = secs != null && duration != null ? Math.min(secs, duration) : secs;
  const cmd = commandForMedia(verb, v.playState?.state ?? null, can, to);
  const asked = verb === "seek" && to != null ? `seek to ${Math.round(to)}s` : verb;
  log(`${asked} from ${name}: ${cmd ? cmd.type : "nothing to do"}`);
  if (!cmd) return { refused: "nothing" };
  deviceManager.fire(cmd);
  return { done: true };
}
const PORT_RANGE = [1024, 65535] as const;

export const displayServer = new DisplayServer({
  snapshot: () => deviceManager.snapshot(),
  lyrics: (q) => fetchLyrics(q, false),
  lyricsAllowed: () => getSettings().lyrics,
  picture: (url) =>
    fetchPicture(url, artHostTrust(connectedHost()), {
      maxBytes: MAX_PICTURE_BYTES,
      timeoutMs: 8_000,
      logged: false,
    }),
  // the window's own question, a show: a page never rebuilds an index
  trackInfo: (query) => lookupMediaInfo(connectedHost(), query, "show"),
  analysis: (key) => audioAnalysisGet(key),
  token: () => displayToken(),
  pageDir: join(__dirname, "../renderer"),
  log,
  controlFor,
  steer,
  failed: () => {
    state = {
      port: null,
      error: "Display on other screens stopped. Turn it off and back on to restart it.",
    };
    void pushStatus();
  },
});

// a settings change reaches every open page as it reaches the windows (the theme, the accent,
// the display font, the Lyrics switch)
alsoHearSettings((settings) => displayServer.push({ kind: "settings", settings }));
// the controls' switch turned off: nothing is asked about any more (each screen hears "off" with
// the settings, and the route refuses from now)
alsoHearSettings((settings) => {
  if (!settings.displayControl) screenBook.dropAsks();
});

/** The server's own state; the address is added when asked. */
let state: { port: number | null; error: string | null } = { port: null, error: null };

export async function displayStatus(): Promise<DisplayStatus> {
  if (state.port == null) return { running: false, url: null, error: state.error };
  const ip = lanAddress();
  const url = ip
    ? `http://${ip}:${state.port}/?t=${encodeURIComponent(await displayToken())}`
    : null;
  return {
    running: true,
    url,
    error: url ? null : "This computer isn't connected to a network.",
  };
}

async function pushStatus(): Promise<DisplayStatus> {
  const status = await displayStatus();
  broadcastDisplayStatus(status);
  return status;
}

const portOk = (p: number): boolean =>
  Number.isInteger(p) && p >= PORT_RANGE[0] && p <= PORT_RANGE[1];

/** Starts, moves or stops the server to match the settings. */
export async function syncDisplay(s: AppSettings = getSettings()): Promise<DisplayStatus> {
  const want = s.displayServer;
  if (!want.enabled) {
    displayServer.stop();
    state = { port: null, error: null };
    return pushStatus();
  }
  if (!portOk(want.port)) {
    displayServer.stop();
    state = {
      port: null,
      error: `Choose a port from ${PORT_RANGE[0]} to ${PORT_RANGE[1]}.`,
    };
    return pushStatus();
  }
  if (displayServer.running && displayServer.port === want.port) return pushStatus();
  displayServer.stop();
  try {
    await displayServer.start(want.port);
    state = { port: want.port, error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    state = {
      port: null,
      error:
        code === "EADDRINUSE"
          ? `Port ${want.port} is in use by another app. Choose another port.`
          : `Couldn't start: ${(e as Error).message}`,
    };
  }
  return pushStatus();
}

/** A new address: every screen on the old one is let go at once, and its reconnect meets the
 *  "open the address" page. */
export async function newDisplayAddress(): Promise<DisplayStatus> {
  await newDisplayToken();
  displayServer.closeScreens();
  // and every approval with it
  screenBook.clear();
  return syncDisplay();
}
