// A PRESET RECALL THAT LOADED NOTHING, DECIDED ONCE (0.15.0, his A on the decision page "Hygiene
// Pass Decisions"). The streamer accepts a preset whose album its server no longer has and then
// does nothing. The Presets screen used to decide that at 8 s from the click (so a wake from
// standby ate 3 of them, and only while the screen was open), and the listening record at 15 s:
// two clocks for one question. Now one, here in main, for every recall the app sends (the screen,
// the tray, a link, an agent, a schedule): 8 s after the streamer is awake, a recall that changed
// nothing about what plays has come to nothing. DeviceManager tells the record and the windows.

/** How long a recall may take to change what plays, from when the streamer is awake. */
export const DEAD_RECALL_MS = 8_000;

export interface RecallWatchDeps {
  /** What plays, as one comparable string: a recall that loads anything changes it. */
  signature(): string;
  /** Whether the streamer is awake (a recall sent in standby starts its clock on waking). */
  awake(): boolean;
  /** The recall came to nothing. */
  onDead(presetId: number): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

export class RecallWatch {
  private watching: { id: number; before: string; timer: unknown } | null = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly deps: RecallWatchDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** A recall the app sent. One already playing changes nothing, rightly, so it is not watched. */
  recalled(id: number, alreadyPlaying: boolean): void {
    this.cancel();
    if (alreadyPlaying) return;
    this.watching = { id, before: this.deps.signature(), timer: null };
    if (this.deps.awake()) this.arm();
  }

  /** The streamer woke: a recall sent in standby starts its wait now. */
  onAwake(): void {
    if (this.watching && this.watching.timer == null) this.arm();
  }

  /** What plays changed: a watched recall loaded something. */
  onPlayback(): void {
    if (this.watching && this.deps.signature() !== this.watching.before) this.cancel();
  }

  /** Stop watching (a new connection, a disconnect). */
  cancel(): void {
    if (this.watching?.timer != null) this.clearTimer(this.watching.timer);
    this.watching = null;
  }

  private arm(): void {
    const w = this.watching;
    if (!w) return;
    w.timer = this.setTimer(() => {
      if (this.watching !== w) return;
      this.watching = null;
      if (this.deps.signature() === w.before) this.deps.onDead(w.id);
    }, DEAD_RECALL_MS);
  }
}
