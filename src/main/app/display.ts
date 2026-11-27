import { join } from "node:path";
import { app } from "electron";
import {
  PLAYLISTS_SENT,
  powerLine,
  powerVerb,
  queueWindow,
  screenCode,
  type DisplayControl,
  type DisplayControlAnswer,
  type DisplayScreen,
  type DisplayVerb,
  type DisplayVerbArgs,
  type PowerFacts,
} from "@shared/displayControl";
import { isDeviceArt } from "@shared/artUrl";
import { errorMessage } from "@shared/guards";
import type { DisplayStatus } from "@shared/ipc";
import { playlistTotalSecs, type AppSettings } from "@shared/model";
import { activeSourceId, isCbusMode, isPreAmpMode } from "@shared/smoip";
import { commandForMedia, transportAbilities } from "@shared/transport";
import { jsonFileStore } from "../data/jsonStore";
import { carriedNone, withCarried } from "../data/savedChecks";
import { getPlaylists } from "../data/playlists";
import { artHostTrust, fetchPicture } from "../lookups/artFetch";
import { artThumb } from "../lookups/artThumbs";
import { fetchLyrics } from "../lookups/lyrics";
import { audioAnalysisGet } from "../lookups/audioAnalysis";
import { lookupMediaInfo } from "../media/mediaInfo";
import { displayToken, getSettings, newDisplayToken } from "../data/persist";
import { DisplayServer } from "../servers/displayServer";
import { ScreenBook, storedScreens } from "../servers/displayScreens";
import { lanAddress } from "../servers/lanAddress";
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
 * (decisions/0017). Standby is the window's own (network standby, so the screen's Wake brings the
 * streamer back), and the sleep timer the app's own (deviceManager.setSleep), armed as the window
 * arms it. Each in the log, with the screen's name.
 */

const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

/** A later version's screens and the list's own form, written back as found (data/savedChecks). */
let screensCarried = carriedNone();

const screensFile = jsonFileStore<DisplayScreen[]>({
  pathOf: () => join(app.getPath("userData"), "display-screens.json"),
  scope: "display screens",
  encode: (next) => withCarried(next, screensCarried),
  kept: () => screensCarried.notes,
  load: (parsed, setAside) => {
    screensCarried = carriedNone();
    return storedScreens(parsed, setAside, screensCarried);
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
  later: (fn, ms) => void setTimeout(fn, ms),
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

/** The presets, each lit by the window's own rule (shared/litPresets, as main reads it). */
function presetsHere(): DisplayControl["presets"] {
  const v = deviceManager.streamerNow;
  const items = (v.presets?.presets ?? []).filter((p) => p.id != null);
  if (items.length === 0) return null;
  const r = deviceManager.recallsNow;
  const lit = deviceManager.litPresetsNow();
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

/** The streamer is connected and on: a playlist loads into its queue then (loading one doesn't
 *  wake it, unlike a preset's recall). */
function streamerOn(): boolean {
  return (
    deviceManager.connectionNow.phase === "connected" &&
    deviceManager.streamerNow.systemPower?.power === "ON"
  );
}

/** The app's playlists, as the menu bar panel lists them: the first picture, the track count, the
 *  running time, and how far one on its way into the queue has got. */
function playlistsHere(): DisplayControl["playlists"] {
  const lists = getPlaylists();
  if (lists.length === 0 || !streamerOn()) return null;
  const run = deviceManager.playlistActivation;
  const loading = run && !run.finished ? run : null;
  return lists.slice(0, PLAYLISTS_SENT).map((p) => {
    const secs = playlistTotalSecs(p);
    return {
      id: p.id,
      name: p.name,
      art: p.items.find((i) => i.artUrl)?.artUrl ?? null,
      tracks: p.items.length,
      secs: secs > 0 ? secs : null,
      loading: loading?.playlistId === p.id ? { done: loading.done, total: loading.total } : null,
    };
  });
}

/** What standby and the sleep timer on a screen go by: the streamer on, the app's sleep action,
 *  what is playing (for the end of the track) and the timer as armed. */
function powerFacts(): PowerFacts {
  const v = deviceManager.streamerNow;
  return {
    on: streamerOn(),
    action: getSettings().sleepAction,
    playState: v.playState ?? null,
    nowPlaying: v.nowPlaying ?? null,
    timer: deviceManager.sleepNow,
  };
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
  // the short code the page shows while it asks, as the prompt and Settings show it
  const code = screen ? screenCode(screen) : null;
  if (state !== "allowed")
    return {
      state,
      volume: null,
      next: null,
      queue: null,
      presets: null,
      playlists: null,
      wake: null,
      resume: null,
      standby: false,
      sleep: null,
      code,
    };
  const starts = s.displayControlPresets;
  return {
    state,
    code,
    volume: s.displayControlVolume ? volumeHere() : null,
    next: nextInQueue(),
    queue: queueHere(),
    presets: starts ? presetsHere() : null,
    playlists: starts ? playlistsHere() : null,
    wake: !starts
      ? null
      : wakeCanWork()
        ? "ready"
        : deviceManager.connectionNow.phase !== "connected"
          ? "unreachable"
          : null,
    resume: starts ? resumeHere() : null,
    ...(starts ? powerLine(powerFacts()) : { standby: false, sleep: null }),
  };
}

const log = (text: string): void => deviceManager.log("info", "display", text);

/** A screen's verb, past the route's checks. */
function steer(
  screen: string,
  name: string,
  verb: DisplayVerb,
  { id, secs, playlist, minutes }: DisplayVerbArgs,
): DisplayControlAnswer {
  const s = getSettings();
  const state = screenBook.stateOf(screen, s.displayControl);
  if (state === "ask") {
    // logged only when it asked: a stream of made-up screens past the cap would fill the log
    const asked = screenBook.ask(screen, name, s.displayControl);
    if (asked === "asking") log(`${name} asks to control playback`);
    return { refused: asked };
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
  // STANDBY AND THE SLEEP TIMER, under the switch of the controls that start music: standby as the
  // window's power button and the sleep timer send it, network standby (the screen's Wake brings
  // it back); the timer the app's own, its action and fade the app's settings
  if (verb === "standby" || verb === "sleep" || verb === "sleepCancel") {
    if (!s.displayControlPresets) return { refused: "presets" };
    const does = powerVerb(verb, minutes, powerFacts(), Date.now());
    const asked =
      verb === "standby"
        ? "standby"
        : verb === "sleepCancel"
          ? "cancel the sleep timer"
          : minutes === "track"
            ? "sleep at the end of the track"
            : `sleep in ${minutes} min`;
    const did = !does
      ? "nothing to do"
      : "standby" in does
        ? "power NETWORK"
        : does.sleep
          ? `setSleep ${does.sleep.action}`
          : "setSleep off";
    log(`${asked} from ${name}: ${did}`);
    if (!does) return { refused: "nothing" };
    if ("standby" in does) deviceManager.fire({ type: "power", power: "NETWORK" });
    else deviceManager.setSleep(does.sleep);
    return { done: true };
  }
  // THE CONTROLS THAT START MUSIC (step three), with their own switch: a preset (a recall on a
  // sleeping streamer wakes it first, as in the window), Wake, picking up where it left off
  if (
    verb === "playPreset" ||
    verb === "playPlaylist" ||
    verb === "stopPlaylist" ||
    verb === "wake" ||
    verb === "resume"
  ) {
    if (!s.displayControlPresets) return { refused: "presets" };
    if (verb === "stopPlaylist") {
      // a playlist on its way into the queue, stopped: the window's Stop loading (what is already
      // in the queue stays, as there)
      const run = deviceManager.playlistActivation;
      const loading = run && !run.finished ? run : null;
      log(
        `stop loading ${loading ? loading.name : "a playlist"} from ${name}: ${loading ? "cancelPlaylistActivation" : "nothing to do"}`,
      );
      if (!loading) return { refused: "nothing" };
      deviceManager.cancelPlaylistActivation();
      return { done: true };
    }
    if (verb === "playPlaylist") {
      // one of the app's playlists, the window's own Play: it replaces the queue, a track at a
      // time; never two at once, never into a sleeping streamer, never an empty one
      const p = getPlaylists().find((x) => x.id === playlist);
      const run = deviceManager.playlistActivation;
      const why = !p
        ? "nothing to do"
        : p.items.length === 0
          ? "nothing to do (empty)"
          : run && !run.finished
            ? `nothing to do (still loading ${run.name})`
            : !streamerOn()
              ? "nothing to do (the streamer isn't on)"
              : null;
      log(`playlist ${p ? p.name : playlist} from ${name}: ${why ?? "playlistActivate"}`);
      if (why || !p) return { refused: "nothing" };
      void deviceManager
        .playlistActivate(p.id)
        .catch((e: unknown) => log(`playlist ${p.name} from ${name} stopped: ${String(e)}`));
      return { done: true };
    }
    if (verb === "playPreset") {
      const items = deviceManager.streamerNow.presets?.presets ?? [];
      const there = id != null && items.some((p) => p.id === id);
      log(`preset ${id} from ${name}: ${there ? "recallPreset" : "nothing to do"}`);
      if (!there || id == null) return { refused: "nothing" };
      // whether it already plays, main works out for every recall
      deviceManager.fire({ type: "recallPreset", presetId: id });
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
  // a list's row or card: the window's own thumbnail cache, keyed as the window's queue rows key
  // it (by the address), so a picture either drew is on disk for the other, and the streamer's
  // own art server is asked one picture at a time
  thumb: (url, tier) => {
    const host = connectedHost();
    return artThumb(url, tier, url, artHostTrust(host), isDeviceArt(url, host));
  },
  // the window's own question, a show: a page never rebuilds an index
  trackInfo: (query) => lookupMediaInfo(connectedHost(), query, "show"),
  analysis: (key) => audioAnalysisGet(key),
  // a saved address that couldn't be read matches nothing (the server isn't started under one)
  token: async () => (await displayToken()) ?? "",
  pageDir: join(__dirname, "../renderer"),
  log,
  controlFor,
  steer,
  failed: () => {
    state = {
      port: null,
      error: "Second screen stopped. Turn it off and back on to restart it.",
      addressUnreadable: false,
    };
    void pushStatus();
  },
});

// a settings change reaches every open page as it reaches the windows (the theme, the accent,
// the display font, the Lyrics switch)
alsoHearSettings((settings) => displayServer.push({ kind: "settings", settings }));
// the controls' switch or the display's own turned off: nothing is asked about any more (each
// screen hears "off" with the settings, or is let go, and the route refuses from now)
alsoHearSettings((settings) => {
  if (!settings.displayControl || !settings.displayServer.enabled) screenBook.dropAsks();
});

/** The server's own state; the address is added when asked. */
let state: { port: number | null; error: string | null; addressUnreadable: boolean } = {
  port: null,
  error: null,
  addressUnreadable: false,
};

/** Said on the card when the saved address couldn't be read (data/secrets' unreadable). */
const ADDRESS_UNREADABLE = "Couldn't read the saved address. Click New address to make a new one.";
/** Said on the card when the first address couldn't be saved (a full disk, a refused keychain). */
const ADDRESS_NOT_MADE =
  "Couldn't make an address. Turn Second screen off and back on to try again.";

export async function displayStatus(): Promise<DisplayStatus> {
  if (state.port == null)
    return {
      running: false,
      url: null,
      error: state.error,
      addressUnreadable: state.addressUnreadable,
    };
  // the address on the network that holds the streamer, where one does (servers/lanAddress)
  const ip = lanAddress(connectedHost());
  const token = await displayToken();
  const url = ip && token ? `http://${ip}:${state.port}/?t=${encodeURIComponent(token)}` : null;
  return {
    running: true,
    url,
    error: url ? null : "This computer isn't connected to a network.",
    addressUnreadable: false,
  };
}

/** The address Settings was last told. */
let shownUrl: string | null = null;

async function pushStatus(): Promise<DisplayStatus> {
  const status = await displayStatus();
  shownUrl = status.url;
  broadcastDisplayStatus(status);
  return status;
}

/** A streamer connected: the address is worked out again, and Settings hears it when it differs.
 *  Second screen switched on at launch starts before the app connects, so its first address
 *  can't prefer the streamer's network (servers/lanAddress); this one can, as the agents' server's
 *  does (servers/mcpServer streamerConnected). */
export async function displayStreamerConnected(): Promise<void> {
  if (state.port == null) return;
  const status = await displayStatus().catch(() => null);
  if (!status || status.url === shownUrl) return;
  shownUrl = status.url;
  broadcastDisplayStatus(status);
}

const portOk = (p: number): boolean =>
  Number.isInteger(p) && p >= PORT_RANGE[0] && p <= PORT_RANGE[1];

/** Starts, moves or stops the server to match the settings. */
export async function syncDisplay(s: AppSettings = getSettings()): Promise<DisplayStatus> {
  const want = s.displayServer;
  if (!want.enabled) {
    displayServer.stop();
    state = { port: null, error: null, addressUnreadable: false };
    return pushStatus();
  }
  if (!portOk(want.port)) {
    displayServer.stop();
    state = {
      port: null,
      error: `Choose a port from ${PORT_RANGE[0]} to ${PORT_RANGE[1]}.`,
      addressUnreadable: false,
    };
    return pushStatus();
  }
  if (displayServer.running && displayServer.port === want.port) return pushStatus();
  displayServer.stop();
  // the address read (or minted, the first time) before the server starts: one saved that couldn't
  // be read is kept as it is, and the server waits for New address rather than make one unasked;
  // a first one that couldn't be saved (undefined) is said on the card and in the log
  const token = await displayToken().catch((e: unknown) => {
    deviceManager.log("error", "display", `the address couldn't be made (${errorMessage(e)})`);
    return undefined;
  });
  // the read can wait on the keychain (a system prompt), and the switch or the port may have
  // changed meanwhile: what is wanted now is what counts, never the settings this call began with,
  // so a switch turned off during the read leaves nothing serving
  const now = getSettings().displayServer;
  if (!now.enabled || now.port !== want.port) return syncDisplay(getSettings());
  if (token === undefined) {
    state = { port: null, error: ADDRESS_NOT_MADE, addressUnreadable: false };
    return pushStatus();
  }
  if (token == null) {
    state = { port: null, error: ADDRESS_UNREADABLE, addressUnreadable: true };
    return pushStatus();
  }
  if (displayServer.running && displayServer.port === want.port) return pushStatus();
  try {
    await displayServer.start(want.port);
    state = { port: want.port, error: null, addressUnreadable: false };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    state = {
      port: null,
      error:
        code === "EADDRINUSE"
          ? `Port ${want.port} is in use by another app. Choose another port.`
          : `Couldn't start: ${(e as Error).message}`,
      addressUnreadable: false,
    };
  }
  return pushStatus();
}

/** A new address: every screen on the old one is let go at once, and its reconnect meets the
 *  "open the address" page; keysSetAside when the saved keys couldn't be read and were set aside
 *  to make it (data/secrets renewSecret). */
export async function newDisplayAddress(): Promise<{
  status: DisplayStatus;
  keysSetAside: boolean;
}> {
  const keysSetAside = await newDisplayToken();
  displayServer.closeScreens();
  // and every approval with it
  screenBook.clear();
  // a later version's screens kept in the file go too: they may be approvals
  if (screensCarried.rows.length > 0) {
    screensCarried = { ...screensCarried, rows: [], notes: [] };
    screensFile.set([]);
  }
  return { status: await syncDisplay(), keysSetAside };
}
