import { createHash } from "node:crypto";
import type { DisplayControl } from "@shared/displayControl";
import type { PushMessage, Snapshot } from "@shared/ipc";
import { DEFAULT_SETTINGS, type AppSettings } from "@shared/model";
import type {
  SystemPower,
  ZoneNowPlaying,
  ZoneNowPlayingDisplay,
  ZonePlayState,
  ZonePlayStateMetadata,
  ZonePosition,
} from "@shared/smoip";

/**
 * WHAT A SCREEN ON THE NETWORK MAY SEE (0.17.0, Display on other screens): the reduced feed the
 * display server hands a browser, never the app's own snapshot or push stream. Pure, unit-tested.
 *
 * - The playing track, its state and position, the streamer's power, and the settings Display
 *   draws with (display*, theme, accent, ambient art, motion); everything else is the default or
 *   empty: no device book, no addresses, no logs, no history, no library, no favorites.
 * - Pictures by id, never by address: an art URL becomes /art/<id>, and the server serves only
 *   ids it handed out (a route that fetched an address would fetch anything for anyone).
 * - Nothing here carries a way back: the one write route and what a screen is told of it are the
 *   server's (displayServer, shared/displayControl).
 */

/** A picture's id: its address hashed, so the page never sees the address. */
export const artIdOf = (url: string): string =>
  createHash("sha256").update(url).digest("hex").slice(0, 24);

/** The page's address for a picture, and the server's note of which address the id stands for. */
export type ArtRegistry = (url: string) => string;

/** The settings a page draws with, by name (a new key reaches the network only once it is
 *  listed here; displayFeed.test holds every display* key to this list or HELD_SETTINGS). */
export const SHOWN_SETTINGS = [
  "theme",
  "accent",
  "ambientArt",
  "motion",
  "lyrics",
  // the audio analysis switch: off, the scenes draw nothing measured, as in the window
  "waveforms",
  "displayFont",
  "displayHintSeen",
  "displayWaveform",
  "displayLyrics",
  "displayScene",
  "displaySceneSettings",
  "displaySyncMs",
  "displayDrops",
  "displayFinish",
  "displayCathodeCurve",
  "displayCathodeFill",
  "displayCornerTitle",
  "displayCornerClock",
  "displayProgress",
  "displayCathodeFlicker",
  "displayShuffleOrder",
  "displayShuffleEvery",
  "displayShuffleExclude",
] as const satisfies readonly (keyof AppSettings)[];

/** Display settings a page never sees: the server's own switch and port, and the controls'
 *  switches (a screen hears only where it stands itself, over its own line: displayServer). */
export const HELD_SETTINGS = [
  "displayServer",
  "displayControl",
  "displayControlVolume",
  "displayControlPresets",
] as const satisfies readonly (keyof AppSettings)[];

/** Display's own settings and the look they draw with, over the defaults. The scene is the
 *  owner's: the page draws it where the browser can (WebGL2), the Sleeve's face elsewhere
 *  (display/page). */
export function displaySettings(s: AppSettings): AppSettings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const k of SHOWN_SETTINGS) out[k] = s[k];
  return out as unknown as AppSettings;
}

// EVERY FIELD BY NAME (the wire check keeps fields it doesn't know, device/frameCheck): a field a
// firmware adds to the streamer's answers reaches the app, never a screen on the network, until
// it is named here. The types make each list whole: a field the app learns is a decision here.

function metadataOf(md: ZonePlayStateMetadata, art: ArtRegistry): ZonePlayStateMetadata {
  return {
    class: md.class ?? null,
    source: md.source ?? null,
    name: md.name ?? null,
    playback_source: md.playback_source ?? null,
    track_number: md.track_number ?? null,
    duration: md.duration ?? null,
    album: md.album ?? null,
    artist: md.artist ?? null,
    title: md.title ?? null,
    art_url: md.art_url ? art(md.art_url) : null,
    sample_format: md.sample_format ?? null,
    mqa: md.mqa ?? null,
    codec: md.codec ?? null,
    lossless: md.lossless ?? null,
    sample_rate: md.sample_rate ?? null,
    bit_depth: md.bit_depth ?? null,
    encoding: md.encoding ?? null,
    station: md.station ?? null,
    bitrate: md.bitrate ?? null,
    radio_id: md.radio_id ?? null,
  };
}

export function displayPlayState(ps: ZonePlayState, art: ArtRegistry): ZonePlayState {
  return {
    state: ps.state ?? null,
    position: ps.position ?? null,
    presettable: ps.presettable ?? null,
    queue_index: ps.queue_index ?? null,
    queue_length: ps.queue_length ?? null,
    queue_id: ps.queue_id ?? null,
    mode_repeat: ps.mode_repeat ?? null,
    mode_shuffle: ps.mode_shuffle ?? null,
    metadata: ps.metadata ? metadataOf(ps.metadata, art) : null,
  };
}

function nowDisplayOf(d: ZoneNowPlayingDisplay, art: ArtRegistry): ZoneNowPlayingDisplay {
  return {
    line1: d.line1 ?? null,
    line2: d.line2 ?? null,
    line3: d.line3 ?? null,
    format: d.format ?? null,
    mqa: d.mqa ?? null,
    playback_source: d.playback_source ?? null,
    class: d.class ?? null,
    art_url: d.art_url ? art(d.art_url) : null,
    // the streamer's own file path for the art never goes: a page needs only the picture's id
    art_file: null,
    progress: d.progress
      ? { position: d.progress.position ?? null, duration: d.progress.duration ?? null }
      : null,
    context: d.context ?? null,
  };
}

export function displayNowPlaying(np: ZoneNowPlaying, art: ArtRegistry): ZoneNowPlaying {
  return {
    state: np.state ?? null,
    source: np.source ? { id: np.source.id ?? null, name: np.source.name ?? null } : null,
    display: np.display ? nowDisplayOf(np.display, art) : null,
    queue: np.queue
      ? {
          length: np.queue.length ?? null,
          position: np.queue.position ?? null,
          shuffle: np.queue.shuffle ?? null,
          repeat: np.queue.repeat ?? null,
        }
      : null,
    controls: Array.isArray(np.controls) ? np.controls.filter((c) => typeof c === "string") : null,
  };
}

const positionOf = (p: ZonePosition): ZonePosition => ({ position: p.position });

/** The streamer's power, and nothing else of its power settings. */
const powerOf = (p: SystemPower): SystemPower => ({ power: p.power });

/** The page's whole first look: the snapshot, reduced. */
export function displaySnapshot(snap: Snapshot, art: ArtRegistry): Snapshot {
  const c = snap.connection;
  return {
    connection:
      c.phase === "connected" ? { phase: "connected", host: "", demo: c.demo } : { phase: "idle" },
    devices: [],
    discovering: false,
    settings: displaySettings(snap.settings),
    playState: snap.playState ? displayPlayState(snap.playState, art) : null,
    position: snap.position ? positionOf(snap.position) : null,
    nowPlaying: snap.nowPlaying ? displayNowPlaying(snap.nowPlaying, art) : null,
    zoneState: null,
    queue: null,
    presets: null,
    systemInfo: null,
    systemPower: snap.systemPower ? powerOf(snap.systemPower) : null,
    firmwareUpdate: null,
    sources: null,
    zoneAudio: null,
    audioSpec: null,
    systemDisplay: null,
    displaySpec: null,
    powerSpec: null,
    sleep: null,
    lastRecalledPresetId: null,
    recents: [],
    favorites: [],
    playlists: [],
    playlistActivation: null,
    held: null,
    mcpStatus: { running: false, url: null, error: null },
    missedSchedule: null,
    mediaIndex: [],
    frames: [],
    logs: [],
    netRequests: [],
  };
}

/** A screen's control line as it is sent: the queue's and the presets' pictures by id, never by
 *  address. */
export function displayControlLine(c: DisplayControl, art: ArtRegistry): DisplayControl {
  const byId = <T extends { art: string | null }>(rows: T[] | null): T[] | null =>
    rows && rows.map((r) => ({ ...r, art: r.art ? art(r.art) : null }));
  return { ...c, queue: byId(c.queue), presets: byId(c.presets) };
}

/** A push the page may hear, reduced; null for any other kind. */
export function displayPush(msg: PushMessage, art: ArtRegistry): PushMessage | null {
  switch (msg.kind) {
    case "playState":
      return { kind: "playState", data: displayPlayState(msg.data, art) };
    case "nowPlaying":
      return { kind: "nowPlaying", data: displayNowPlaying(msg.data, art) };
    case "position":
      return { kind: "position", data: positionOf(msg.data) };
    case "systemPower":
      return { kind: "systemPower", data: powerOf(msg.data) };
    case "connection":
      return {
        kind: "connection",
        state:
          msg.state.phase === "connected"
            ? { phase: "connected", host: "", demo: msg.state.demo }
            : { phase: "idle" },
      };
    case "settings":
      return { kind: "settings", settings: displaySettings(msg.settings) };
    default:
      return null;
  }
}
