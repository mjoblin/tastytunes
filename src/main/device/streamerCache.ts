import type { StreamerCommand } from "@shared/ipc";
import { presetVolumeHolds, presetVolumeKey, type FirmwareStatus } from "@shared/model";
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
 *  the app after a beat for the source switch: the level for this streamer's slot when it was set
 *  for the preset now there (presetVolumeHolds, main/device/presetSlots), or none. One rule for
 *  every connection that recalls. */
export const PRESET_VOLUME_DELAY_MS = 1200;
export function presetVolumeFor(
  streamerUdn: string | null | undefined,
  presetId: number,
  presetName: string | null | undefined,
): number | null {
  const { presetVolumes, presetVolumeNames } = getSettings();
  const key = presetVolumeKey(streamerUdn, presetId);
  const level = presetVolumes[key];
  return level != null && presetVolumeHolds(presetVolumeNames, key, presetName) ? level : null;
}

/** How long a recall's level waits for what plays to change before it is let go: a wake from
 *  standby (a recall wakes the streamer, ~10 s) and then the recall watch's own wait. */
export const PRESET_VOLUME_GIVE_UP_MS = 20_000;

/** The commands after which a recall's level no longer belongs: something else was asked to play,
 *  or the volume was set by hand. */
export const PRESET_VOLUME_CANCELLED_BY: ReadonlySet<StreamerCommand["type"]> = new Set<
  StreamerCommand["type"]
>([
  "playQueueId",
  "streamRadio",
  "setSource",
  "nextTrack",
  "previousTrack",
  "setVolumePercent",
  "setVolumeStep",
  "volumeStepChange",
  "setMute",
]);

/**
 * A RECALL'S LEVEL, SENT ONLY ONCE THE RECALL LANDED. The streamer accepts a recall of a preset it
 * can no longer play and changes nothing, so a level sent on a timer alone set the volume on
 * whatever was already playing. The level waits for what plays to change (recallSignature), then
 * for the beat after the recall the source switch needs; a recall of what already plays changes
 * nothing, rightly, and gets its level after the beat. A newer recall, a command in
 * PRESET_VOLUME_CANCELLED_BY, a new connection or PRESET_VOLUME_GIVE_UP_MS without a change lets
 * it go. One per connection: the window's (DeviceManager) and an agent's (RemoteStreamer).
 */
export class PresetVolumeAfterRecall {
  private pending: {
    level: number;
    before: string;
    at: number;
    timer: unknown;
    armed: boolean;
  } | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(
    private readonly deps: {
      /** What plays, as one comparable string (recallSignature of the play state). */
      signature(): string;
      apply(level: number): void;
      now?: () => number;
      setTimer?(fn: () => void, ms: number): unknown;
      clearTimer?(t: unknown): void;
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** A recall was sent, with its preset's level (null: none, or the caller sets its own). */
  recalled(level: number | null, alreadyPlaying: boolean): void {
    this.cancel();
    if (level == null) return;
    const p = {
      level,
      before: this.deps.signature(),
      at: this.now(),
      timer: null as unknown,
      armed: false,
    };
    this.pending = p;
    if (alreadyPlaying) this.arm(p, PRESET_VOLUME_DELAY_MS);
    else
      p.timer = this.setTimer(() => {
        if (this.pending === p) this.pending = null;
      }, PRESET_VOLUME_GIVE_UP_MS);
  }

  /** What plays may have changed (every play-state push). */
  onPlayback(): void {
    const p = this.pending;
    if (!p || p.armed || this.deps.signature() === p.before) return;
    this.clearTimer(p.timer);
    this.arm(p, Math.max(0, PRESET_VOLUME_DELAY_MS - (this.now() - p.at)));
  }

  /** A command was sent: one that asks for something else, or sets the volume, lets it go. */
  onCommand(type: StreamerCommand["type"]): void {
    if (PRESET_VOLUME_CANCELLED_BY.has(type)) this.cancel();
  }

  cancel(): void {
    if (this.pending) this.clearTimer(this.pending.timer);
    this.pending = null;
  }

  private arm(p: NonNullable<PresetVolumeAfterRecall["pending"]>, ms: number): void {
    p.armed = true;
    p.timer = this.setTimer(() => {
      if (this.pending !== p) return;
      this.pending = null;
      this.deps.apply(p.level);
    }, ms);
  }
}
