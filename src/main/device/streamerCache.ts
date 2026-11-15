import type { StreamerCommand } from "@shared/ipc";
import { presetVolumeKey, type FirmwareStatus } from "@shared/model";
import { getSettings } from "../data/persist";
import type {
  Presets,
  QueueList,
  SystemDisplay,
  SystemDisplaySpec,
  SystemInfo,
  SystemPower,
  SystemPowerSpec,
  SystemSources,
  SystemUpdate,
  ZoneAudio,
  ZoneAudioSpec,
  ZoneNowPlaying,
  ZonePlayState,
  ZonePosition,
  ZoneState,
} from "@shared/smoip";

// WHAT A STREAMER IS DOING, AS ITS SOCKET SAYS (0.16.0, lifted out of DeviceManager when a second
// connection joined it): the cache each connection keeps and the one rule for which frame fills
// which part of it. The window's connection (DeviceManager) and an agent's connection to another
// streamer (RemoteStreamer) both apply frames through applyFrame, so they cannot read the wire
// differently; what each then DOES with a frame (the listening record, the window's pushes) stays
// its own.

export interface StreamerCache {
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
  zoneAudio: ZoneAudio | null;
  audioSpec: ZoneAudioSpec | null;
  systemDisplay: SystemDisplay | null;
  displaySpec: SystemDisplaySpec | null;
  powerSpec: SystemPowerSpec | null;
}

export const emptyCache = (): StreamerCache => ({
  playState: null,
  position: null,
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
});

/** The pushed paths and the part of the cache each fills, as the frame's data says it. */
const FILLS: Partial<Record<string, keyof StreamerCache>> = {
  "/zone/play_state": "playState",
  "/zone/play_state/position": "position",
  "/zone/now_playing": "nowPlaying",
  "/zone/state": "zoneState",
  "/queue/list": "queue",
  "/presets/list": "presets",
  "/system/info": "systemInfo",
  "/system/power": "systemPower",
  "/system/sources": "sources",
  "/zone/audio": "zoneAudio",
  "/system/display": "systemDisplay",
};

/**
 * A checked frame's data into the cache (checkFrame first, the caller's): the part its path
 * fills, and /system/update's read-only self-check camelcased into the FirmwareStatus the window
 * reads (never acted on: the PASSIVE-ONLY guard in DeviceManager.command). Other paths (command
 * echoes, /queue/info) fill nothing.
 */
export function applyFrame(cache: StreamerCache, path: string, data: unknown): void {
  if (path === "/system/update") {
    const u = data as SystemUpdate;
    cache.firmwareUpdate = {
      updateAvailable: u.update_available === true,
      updating: u.updating === true,
      earlyUpdate: u.early_update === true,
    };
    return;
  }
  const field = FILLS[path];
  if (field) (cache as unknown as Record<string, unknown>)[field] = data;
}

/** Play-shaped commands that wake a standby streamer first (FIRMWARE TRUTH, live-probed
 *  2026-07-23: play verbs do NOT auto-wake; standby refuses them with code 114). */
export const WAKE_COMMANDS: ReadonlySet<StreamerCommand["type"]> = new Set<StreamerCommand["type"]>(
  ["play", "togglePlayback", "playQueueId", "recallPreset", "streamRadio", "setSource"],
);

/** A preset's own volume, set through the app (Feature 10), rides along on every recall through
 *  the app after a beat for the source switch: the level for this streamer's slot, or none. One
 *  rule for every connection that recalls. */
export const PRESET_VOLUME_DELAY_MS = 1200;
export function presetVolumeFor(
  streamerUdn: string | null | undefined,
  presetId: number,
): number | null {
  return getSettings().presetVolumes[presetVolumeKey(streamerUdn, presetId)] ?? null;
}
