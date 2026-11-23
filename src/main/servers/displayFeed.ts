import { createHash } from "node:crypto";
import type { PushMessage, Snapshot } from "@shared/ipc";
import { DEFAULT_SETTINGS, type AppSettings } from "@shared/model";
import type { ZoneNowPlaying, ZonePlayState } from "@shared/smoip";

/**
 * WHAT A SCREEN ON THE NETWORK MAY SEE (0.17.0, Display on other screens): the reduced feed the
 * display server hands a browser, never the app's own snapshot or push stream. Pure, unit-tested.
 *
 * - The playing track, its state and position, the streamer's power, and the settings Display
 *   draws with (display*, theme, accent, ambient art, motion); everything else is the default or
 *   empty: no device book, no addresses, no logs, no history, no library, no favorites.
 * - Pictures by id, never by address: an art URL becomes /art/<id>, and the server serves only
 *   ids it handed out (a route that fetched an address would fetch anything for anyone).
 * - Read only: nothing here carries a way back.
 */

/** A picture's id: its address hashed, so the page never sees the address. */
export const artIdOf = (url: string): string =>
  createHash("sha256").update(url).digest("hex").slice(0, 24);

/** The page's address for a picture, and the server's note of which address the id stands for. */
export type ArtRegistry = (url: string) => string;

const SHOWN_SETTING = /^(display(?!Server)|theme$|accent|ambientArt$|motion$|lyrics$)/;

/** Display's own settings and the look they draw with, over the defaults; scenes stay the Sleeve
 *  until the page can run them (stage 2). */
export function displaySettings(s: AppSettings): AppSettings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(s)) if (SHOWN_SETTING.test(k)) out[k] = v;
  out["displayScene"] = "sleeve";
  return out as unknown as AppSettings;
}

function withArt<T extends { art_url?: string | null } | null | undefined>(
  md: T,
  art: ArtRegistry,
): T {
  if (!md?.art_url) return md;
  return { ...md, art_url: art(md.art_url) };
}

export function displayPlayState(ps: ZonePlayState | null, art: ArtRegistry): ZonePlayState | null {
  if (!ps) return ps;
  return { ...ps, metadata: withArt(ps.metadata, art) };
}

export function displayNowPlaying(
  np: ZoneNowPlaying | null,
  art: ArtRegistry,
): ZoneNowPlaying | null {
  if (!np?.display) return np;
  // the streamer's own file path for the art goes too: a page needs only the picture's id
  return { ...np, display: { ...withArt(np.display, art), art_file: null } };
}

/** The page's whole first look: the snapshot, reduced. */
export function displaySnapshot(snap: Snapshot, art: ArtRegistry): Snapshot {
  const c = snap.connection;
  return {
    connection:
      c.phase === "connected" ? { phase: "connected", host: "", demo: c.demo } : { phase: "idle" },
    devices: [],
    discovering: false,
    settings: displaySettings(snap.settings),
    playState: displayPlayState(snap.playState, art),
    position: snap.position,
    nowPlaying: displayNowPlaying(snap.nowPlaying, art),
    zoneState: null,
    queue: null,
    presets: null,
    systemInfo: null,
    systemPower: snap.systemPower,
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

/** A push the page may hear, reduced; null for any other kind. */
export function displayPush(msg: PushMessage, art: ArtRegistry): PushMessage | null {
  switch (msg.kind) {
    case "playState":
      return { kind: "playState", data: displayPlayState(msg.data, art) ?? msg.data };
    case "nowPlaying":
      return { kind: "nowPlaying", data: displayNowPlaying(msg.data, art) ?? msg.data };
    case "position":
    case "systemPower":
      return msg;
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
