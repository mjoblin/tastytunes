import type { StreamerCommand } from "./ipc";
import type { ZonePlayStateState } from "./smoip";

/**
 * WHAT THE TRANSPORT CAN DO, AND WHAT A PRESS SENDS: one home for the app's own buttons (the
 * playback bar, the mini player, the menu bar panel, through useTransport) and the system's media
 * commands (the keys, Control Center, a headset's button, through main/app/nowPlaying). Abilities
 * come from the source's controls list (now_playing), so a source that can't skip or seek offers
 * neither, wherever it is pressed.
 */
export interface TransportAbilities {
  canToggle: boolean;
  canPrev: boolean;
  canNext: boolean;
  canSeek: boolean;
  canShuffle: boolean;
  canRepeat: boolean;
  canStop: boolean;
}

export function transportAbilities(
  controls: readonly string[] | null | undefined,
  duration?: number | null,
): TransportAbilities {
  const has = new Set(controls ?? []);
  return {
    canToggle: has.has("play_pause") || has.has("play") || has.has("pause"),
    canPrev: has.has("track_previous"),
    canNext: has.has("track_next"),
    canSeek: has.has("seek") && duration != null && duration > 0,
    canShuffle: has.has("toggle_shuffle"),
    canRepeat: has.has("toggle_repeat"),
    canStop: has.has("stop"),
  };
}

/** A command from outside the window: the system's media keys, Control Center, a headset. */
export type MediaCommand = "toggle" | "play" | "pause" | "next" | "previous" | "stop" | "seek";

/** The streamer command a media command stands for, as the app's own buttons would send it, or
 *  null when the source can't do it or it is already so. Play and pause go through the toggle the
 *  play button sends: a bare play starts the track again from the top, where the toggle resumes
 *  it; a play while playing and a pause while paused do nothing. */
export function commandForMedia(
  cmd: MediaCommand,
  state: ZonePlayStateState | null,
  can: TransportAbilities,
  seekSecs?: number,
): StreamerCommand | null {
  const playing = state === "play";
  switch (cmd) {
    case "toggle":
      return can.canToggle ? { type: "togglePlayback" } : null;
    case "play":
      return can.canToggle && !playing ? { type: "togglePlayback" } : null;
    case "pause":
      return can.canToggle && playing ? { type: "togglePlayback" } : null;
    case "next":
      return can.canNext ? { type: "nextTrack" } : null;
    case "previous":
      return can.canPrev ? { type: "previousTrack" } : null;
    case "stop":
      return can.canStop ? { type: "stop" } : null;
    case "seek":
      return can.canSeek && seekSecs != null && Number.isFinite(seekSecs)
        ? { type: "seek", positionSecs: Math.max(0, Math.round(seekSecs)) }
        : null;
  }
}
