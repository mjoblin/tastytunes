import type { PushMessage, StreamerCommand } from "@shared/ipc";
import { sleepTrackKey, type SleepTimer } from "@shared/model";
import type { ZonePlayState } from "@shared/smoip";
import { getSettings } from "../data/persist";
import type { VolumeFader } from "./volumeFader";

export interface SleepDeps {
  fader: VolumeFader;
  connected(): boolean;
  command(cmd: StreamerCommand): Promise<void>;
  push(msg: PushMessage): void;
  log(text: string): void;
}

/**
 * THE SLEEP TIMER (split out of DeviceManager in the 0.11.0 sweep). Lives in main, not a
 * renderer, so it survives the window closing on macOS. Node timers stall during system
 * sleep, so checkSleepTimer() re-evaluates the absolute deadline on resume.
 */
export class SleepCountdown {
  private sleep: SleepTimer | null = null;
  private sleepTimeout: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SleepDeps) {}

  get current(): SleepTimer | null {
    return this.sleep;
  }

  /** Arm or clear the sleep timer. */
  setSleep(sleep: SleepTimer | null): void {
    this.sleep = sleep;
    if (this.sleepTimeout) {
      clearTimeout(this.sleepTimeout);
      this.sleepTimeout = null;
    }
    if (sleep) {
      this.deps.log(
        sleep.minutes != null
          ? `armed: ${sleep.action} in ${sleep.minutes} min`
          : `armed: ${sleep.action} at end of track`,
      );
    }
    // Arming (or re-arming) replaces any fade in flight; clearing restores the level.
    this.deps.fader.cancelFade(sleep == null);
    if (sleep?.firesAt != null) {
      const ms = sleep.firesAt - Date.now();
      if (ms <= 0) {
        this.fireSleep();
        return;
      }
      this.sleepTimeout = setTimeout(() => this.fireSleep(), ms);
      // Countdown fade-out: ramp to near-silence over the last stretch, pre-amp
      // mode only, honoring the setting. End-of-track timers never fade (no
      // advance warning), and a timer shorter than the fade ramps from now.
      if (getSettings().sleepFade && this.deps.fader.level() != null)
        this.deps.fader.armFadeOut(ms);
    }
    this.deps.push({ kind: "sleep", sleep: this.sleep });
  }

  /** Fire a countdown that came due while the system was asleep (on resume). */
  checkSleepTimer(): void {
    if (this.sleep?.firesAt != null && Date.now() >= this.sleep.firesAt) this.fireSleep();
  }

  /** The app is quitting: no timer outlives it. */
  stop(): void {
    if (this.sleepTimeout) clearTimeout(this.sleepTimeout);
  }

  private fireSleep(): void {
    const action = this.sleep?.action;
    this.sleep = null;
    if (this.sleepTimeout) {
      clearTimeout(this.sleepTimeout);
      this.sleepTimeout = null;
    }
    this.deps.push({ kind: "sleep", sleep: null });
    // Only touch the streamer while connected — a timer that expires after a
    // dropout should quietly clear, never pause on reconnect.
    const restore = this.deps.fader.stopTakingRestore();
    if (action && this.deps.connected()) {
      this.deps.log(`fired: ${action}`);
      // Pause first either way, put the faded level back while nothing plays
      // (so tomorrow's first press isn't a whisper), then standby if asked.
      void (async () => {
        await this.deps.command({ type: "pause" });
        if (restore != null) {
          await new Promise((r) => setTimeout(r, 400));
          await this.deps.fader.fadeVolumeWrite(restore);
        }
        if (action === "standby") {
          await new Promise((r) => setTimeout(r, 400));
          await this.deps.command({ type: "power", power: "NETWORK" });
        }
      })();
    }
  }

  /** End-of-track sleep: fire when the armed track gives way or playback ends. */
  boundaryCheck(ps: ZonePlayState): void {
    const sleep = this.sleep;
    if (!sleep || sleep.minutes != null) return;
    const key = sleepTrackKey(ps);
    const advanced = sleep.trackKey != null && key != null && key !== sleep.trackKey;
    const ended = ps.state === "stop" || ps.state === "no_signal";
    if (advanced || ended) this.fireSleep();
  }
}
