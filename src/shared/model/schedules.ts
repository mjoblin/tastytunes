// Time-driven actions: scheduled actions (alarms, fades, standby) and the sleep timer.

import type { ZonePlayState } from "../smoip";

// ----------------------------------------------------------- scheduled actions

/**
 * A BluOS-style alarm, executed by the main process while the app runs:
 * wake (power ON, optionally recall a preset and set a volume) or standby.
 */
export interface Schedule {
  id: string;
  enabled: boolean;
  /** Local 24h "HH:MM". */
  time: string;
  /** Days it fires: 0 = Sunday … 6 = Saturday. Empty = never. */
  days: number[];
  action: "on" | "standby";
  /** Wake only: preset to recall after powering on. */
  presetId: number | null;
  /** Wake only: volume to set after the preset settles. */
  volumePercent: number | null;
  /** Wake only, with a volume: ramp up to it instead of jumping (absent = true). */
  fadeIn?: boolean;
}

/**
 * Volume fade length for the sleep timer's fade-out and a wake schedule's
 * fade-in, one constant for both directions. Test harnesses shrink it via
 * TASTYTUNES_FADE_MS; there is deliberately no user knob (a good constant
 * beats a knob, the standing instinct).
 */
export const VOLUME_FADE_MS = 60_000;

/**
 * A wake schedule that came due while the computer was asleep, offered rather
 * than fired (see main/app/scheduler.ts). Held in the main process, mirrored to the
 * renderer so the Schedules tab can show it too — the OS notification is the
 * loud surface, this is the one that survives Do Not Disturb.
 *
 * Ephemeral by design: it dies with the app, like the countdown and lastFired.
 * A missed alarm is only interesting for as long as acting on it still makes
 * sense.
 */
export interface MissedSchedule {
  scheduleId: string;
  /** When it was due — the UI says so, because "missed" without a time is noise. */
  dueAt: number;
}

/** Cache key for a preset volume override — device-scoped so ids don't collide. */
export function presetVolumeKey(udn: string | null | undefined, presetId: number): string {
  return `${udn ?? "device"}|${presetId}`;
}

// ------------------------------------------------------------------- sleep timer

/** What the sleep timer does when it expires. */
export type SleepAction = "pause" | "standby";

/**
 * A live sleep timer. Ephemeral by design — a countdown shouldn't survive a
 * restart. Owned by the main process (so it outlives the window on macOS);
 * renderers arm/disarm via setSleep and mirror state from pushes.
 * `minutes: null` means "end of the current track", in which case `trackKey`
 * is the armed track's identity and `firesAt` is unused.
 */
/** Countdown sleep timers fade the volume down over the last VOLUME_FADE_MS
 *  (pre-amp mode only; the level is restored after the action so tomorrow's
 *  first play isn't a whisper). End-of-track timers fire at a boundary the
 *  app can't see coming, so they never fade. */
export interface SleepTimer {
  action: SleepAction;
  minutes: number | null;
  firesAt: number | null;
  trackKey: string | null;
}

/**
 * Identity of the currently-playing track, used to detect the boundary for an
 * "end of track" sleep timer. Queue playback gives a stable per-item id; other
 * sources (AirPlay, USB) fall back to title/artist. Null when nothing
 * identifiable is playing. Shared so the arming renderer and the firing main
 * process can never disagree.
 */
export function sleepTrackKey(ps: ZonePlayState | null): string | null {
  if (!ps) return null;
  if (ps.queue_id != null) return `q${ps.queue_id}`;
  const md = ps.metadata;
  if (md?.title) return `t:${md.title}:${md.artist ?? ""}`;
  return null;
}
