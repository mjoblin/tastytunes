import { VOLUME_FADE_MS } from "@shared/model";

/** What a fade needs from the device: its pre-amp level, a way to write one, and the log. */
export interface FaderDeps {
  /** The pre-amp level, or null in control-bus mode (no fades there). */
  level(): number | null;
  /** Write a level (the setVolumePercent command). */
  write(percent: number): Promise<void>;
  connected(): boolean;
  log(text: string): void;
}

/**
 * THE VOLUME FADE (split out of DeviceManager in the 0.11.0 sweep): the sleep timer's
 * fade-out and a wake schedule's fade-in, pre-amp mode only. One step a second; a user
 * touching volume, power or transport takes over (DeviceManager.command cancels without
 * restoring), and the fade's own writes are flagged so they never cancel it.
 */
export class VolumeFader {
  private fadeTick: NodeJS.Timeout | null = null;
  private fadeStartTimeout: NodeJS.Timeout | null = null;
  /** The level to put back after a sleep fade's action fires (null = no fade ran). */
  private fadeRestore: number | null = null;
  /** True while the fade engine itself is writing volume — its own commands must not cancel it. */
  private fadeWriting = false;

  constructor(private readonly deps: FaderDeps) {}

  /** A fade is running or armed, and the write in hand is not its own. */
  get interruptible(): boolean {
    return !this.fadeWriting && (this.fadeTick != null || this.fadeStartTimeout != null);
  }

  /** The pre-amp level now, or null in control-bus mode (no fades there). */
  level(): number | null {
    return this.deps.level();
  }

  fadeMs(): number {
    const n = Number(process.env["TASTYTUNES_FADE_MS"]);
    return Number.isFinite(n) && n > 0 ? n : VOLUME_FADE_MS;
  }

  /** Stop any fade. `restore` puts the pre-fade level back (a cancelled fade-out); a user taking over passes false. */
  cancelFade(restore: boolean): void {
    const level = this.stopTakingRestore();
    if (restore && level != null && this.deps.connected()) {
      void this.fadeVolumeWrite(level);
    }
  }

  /** Stop the timers and hand back the level to restore, if a fade-out ran (the sleep action fired). */
  stopTakingRestore(): number | null {
    if (this.fadeTick) clearInterval(this.fadeTick);
    this.fadeTick = null;
    if (this.fadeStartTimeout) clearTimeout(this.fadeStartTimeout);
    this.fadeStartTimeout = null;
    const level = this.fadeRestore;
    this.fadeRestore = null;
    return level;
  }

  async fadeVolumeWrite(percent: number): Promise<void> {
    this.fadeWriting = true;
    try {
      await this.deps.write(percent);
    } finally {
      this.fadeWriting = false;
    }
  }

  /** Ramp the pre-amp volume to `to` over `ms`, one step per second. Resolves when done or cancelled. */
  private rampVolume(to: number, ms: number): Promise<void> {
    const from = this.deps.level();
    if (from == null || from === to) return Promise.resolve();
    if (this.fadeTick) clearInterval(this.fadeTick);
    const steps = Math.max(3, Math.round(ms / 1000));
    const stepMs = ms / steps;
    let i = 0;
    this.deps.log(`fade ${from}% → ${to}% over ${Math.round(ms / 1000)}s`);
    return new Promise((resolve) => {
      this.fadeTick = setInterval(() => {
        i += 1;
        const level = Math.round(from + ((to - from) * i) / steps);
        void this.fadeVolumeWrite(level);
        if (i >= steps) {
          if (this.fadeTick) clearInterval(this.fadeTick);
          this.fadeTick = null;
          resolve();
        }
      }, stepMs);
    });
  }

  /** A wake schedule's fade-in: ramp from the pre-set low level up to `target`. */
  async fadeInTo(target: number): Promise<void> {
    this.fadeRestore = null;
    await this.rampVolume(target, this.fadeMs());
  }

  /**
   * A countdown's fade-out: ramp to near-silence over the last stretch before an action
   * `ms` from now, ending a beat BEFORE it so the last step (near silence) lands instead of
   * racing the action's cleanup; a timer shorter than the fade ramps from now.
   */
  armFadeOut(ms: number): void {
    const fadeMs = Math.min(this.fadeMs(), Math.max(0, ms - 1000));
    if (fadeMs <= 0) return;
    this.fadeStartTimeout = setTimeout(
      () => {
        this.fadeRestore = this.deps.level();
        void this.rampVolume(1, fadeMs);
      },
      Math.max(0, ms - fadeMs - 1000),
    );
  }
}
