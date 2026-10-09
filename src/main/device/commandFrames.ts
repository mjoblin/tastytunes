import type { StreamerCommand } from "@shared/ipc";
import type {
  SystemPower,
  SystemPowerSpec,
  ZoneAudioSpec,
  ZoneNowPlaying,
  ZonePlayState,
  ZoneState,
} from "@shared/smoip";
import { EQ_GAIN_MAX, EQ_GAIN_MIN } from "@shared/smoip";

/** One frame for the socket: a path and its params. */
export type SocketFrame = { path: string; params: Record<string, unknown> };

/** What the translation reads: the device's last word on each, and the volume limit. */
export interface CommandState {
  nowPlaying: ZoneNowPlaying | null;
  playState: ZonePlayState | null;
  zoneState: ZoneState | null;
  systemPower: SystemPower | null;
  audioSpec: ZoneAudioSpec | null;
  powerSpec: SystemPowerSpec | null;
  volumeLimitPercent: number | null;
}

/**
 * The user_eq_bands write string: "<idx>,<freq>,<filter>,<gain>,<q>", blank
 * fields = keep, bands pipe-delimited. Gain-only writes, exactly like the
 * official app ("0,,,3.0,|1,,,1.2,|…"); gains clamp to the official client's
 * −6..+3 dB envelope (the firmware itself stores anything — probed live).
 */
const bandString = (bands: [number, number][]): string =>
  bands
    .map(([i, g]) => `${i},,,${Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, g)).toFixed(1)},`)
    .join("|");

/** The volume a write may ask for: under the limit, 0 to 100, whole. */
export function clampVolume(percent: number, limit: number | null): number {
  const capped = limit != null ? Math.min(percent, limit) : percent;
  return Math.max(0, Math.min(100, Math.round(capped)));
}

/** Clamp an integer tone value to the spec's published range (fallback ±15). */
function clampSpec(value: number, range?: { minimum?: number; maximum?: number }): number {
  return Math.max(range?.minimum ?? -15, Math.min(range?.maximum ?? 15, Math.round(value)));
}

const frame = (path: string, params: Record<string, unknown>): SocketFrame[] => [{ path, params }];

/**
 * THE COMMAND TRANSLATION (split out of DeviceManager.command in the 0.11.0 sweep): what a
 * command sends over the socket, given what the device last said. Pure, so the firmware
 * truths it encodes are unit-tested (commandFrames.test.ts). Returns the frames to send in
 * order ([] sends nothing, on purpose), or null for a command that is not a plain socket
 * write (HTTP verbs, a preset recall, a resume), which DeviceManager carries out itself.
 */
export function commandFrames(cmd: StreamerCommand, s: CommandState): SocketFrame[] | null {
  switch (cmd.type) {
    // Cast-style sources (AirPlay live-proven 2026-07-20) advertise ONLY the
    // toggle verb — now_playing controls say play_pause, never play/pause —
    // and the firmware SILENTLY IGNORES the explicit verbs there. Honor the
    // device's own controls contract: translate to toggle when the explicit
    // verb isn't offered, guarded by current state so pause never resumes.
    case "play": {
      const controls = s.nowPlaying?.controls ?? [];
      if (!controls.includes("play") && controls.includes("play_pause")) {
        if (s.playState?.state === "play") return [];
        return frame("/zone/play_control", { action: "toggle" });
      }
      return frame("/zone/play_control", { action: "play" });
    }
    case "pause": {
      const controls = s.nowPlaying?.controls ?? [];
      if (!controls.includes("pause") && controls.includes("play_pause")) {
        if (s.playState?.state !== "play") return [];
        return frame("/zone/play_control", { action: "toggle" });
      }
      return frame("/zone/play_control", { action: "pause" });
    }
    case "stop":
      return frame("/zone/play_control", { action: "stop" });
    case "togglePlayback":
      return frame("/zone/play_control", { action: "toggle" });
    case "nextTrack":
      return frame("/zone/play_control", { skip_track: 1 });
    case "previousTrack":
      return frame("/zone/play_control", { skip_track: -1 });
    case "seek":
      return frame("/zone/play_control", { position: Math.max(0, Math.round(cmd.positionSecs)) });
    case "playQueueId":
      return frame("/zone/play_control", { queue_id: cmd.queueId });
    case "setRepeat":
      // FIRMWARE (live-probed 2026-09-18, the socket and HTTP alike): off and all set by
      // name, but "one" by name answers 200 and lands on "all". Only the toggle reaches
      // it, stepping all → one → off → all, so the way to one is an absolute "all" and
      // then one toggle, two frames the streamer takes in order (from off they land on
      // one). Already there: nothing to send, since the pair would flash through all.
      if (cmd.mode !== "one") return frame("/zone/play_control", { mode_repeat: cmd.mode });
      if (s.playState?.mode_repeat === "one") return [];
      return [
        { path: "/zone/play_control", params: { mode_repeat: "all" } },
        { path: "/zone/play_control", params: { mode_repeat: "toggle" } },
      ];
    case "setShuffle":
      return frame("/zone/play_control", { mode_shuffle: cmd.mode });
    case "power":
      // Re-sending ON to a powered-on streamer reboots it (PunyTunes' hard-won guard).
      if (cmd.power === "ON" && s.systemPower?.power === "ON") return [];
      return frame("/system/power", { power: cmd.power });
    case "setMute":
      return frame("/zone/state", { mute: cmd.mute });
    case "setSource":
      return frame("/zone/state", { source: cmd.sourceId });
    case "setVolumeStep":
      return frame("/zone/state", { volume_step: cmd.step });
    case "setVolumePercent":
      return frame("/zone/state", {
        volume_percent: clampVolume(cmd.percent, s.volumeLimitPercent),
      });
    case "volumeStepChange": {
      const limit = s.volumeLimitPercent;
      const current = s.zoneState?.volume_percent;
      if (cmd.delta > 0 && limit != null && current != null && current >= limit) return [];
      return frame("/zone/state", { volume_step_change: cmd.delta });
    }
    // ---- /zone/audio tone controls. One frame per logical control: writes
    // are ATOMIC on the firmware (one bad field rejects the whole frame —
    // the stranded-balance lesson from the 2026-07-19 probe). WS params are
    // JSON, so the '+'-literal query-encoding trap doesn't apply here.
    case "setUserEq":
      // Boolean ON WRITE — the read returns {enabled, bands}; writing the
      // object shape 400s with code 112.
      return frame("/zone/audio", { zone: "ZONE1", user_eq: cmd.enabled });
    case "setEqBandGain":
      return frame("/zone/audio", {
        zone: "ZONE1",
        user_eq_bands: bandString([[cmd.index, cmd.gain]]),
      });
    case "setEqBands":
      return frame("/zone/audio", {
        zone: "ZONE1",
        user_eq_bands: bandString(cmd.gains.map((g, i) => [i, g])),
      });
    case "setTiltEq":
      return frame("/zone/audio", { zone: "ZONE1", tilt_eq: cmd.enabled });
    case "setTiltIntensity":
      return frame("/zone/audio", {
        zone: "ZONE1",
        tilt_intensity: clampSpec(cmd.intensity, s.audioSpec?.tilt_eq),
      });
    case "setBalance":
      return frame("/zone/audio", {
        zone: "ZONE1",
        balance: clampSpec(cmd.balance, s.audioSpec?.balance),
      });
    // ---- §10 device controls (writes over the WS like the power command;
    // ---- standby fields are partial writes to /system/power, so they never
    // ---- carry `power` and can't trip the re-send-ON reboot guard)
    case "setBrightness":
      return frame("/system/display", { brightness: cmd.brightness });
    case "setStandbyMode":
      return frame("/system/power", { standby_mode: cmd.mode });
    case "setAutoPowerDown": {
      // Clamp to the probed spec range like balance/tilt — the UI only
      // offers in-range presets, but the boundary shouldn't rely on that.
      const r = s.powerSpec?.auto_power_down;
      const secs = Math.max(0, Math.round(cmd.seconds));
      return frame("/system/power", {
        auto_power_down:
          r?.minimum != null && r?.maximum != null
            ? Math.max(r.minimum, Math.min(r.maximum, secs))
            : secs,
      });
    }
    default:
      return null;
  }
}
