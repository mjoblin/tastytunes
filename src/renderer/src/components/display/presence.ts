/**
 * PRESENCE for things that come and go (after packscape's stage/presence):
 * a lyric line entering the picture, a comet, a signpost. Observe this
 * frame's membership and every key ramps toward 1 while present and toward
 * 0 once gone, LINEARLY, so a value actually reaches its end and a departed
 * key is forgotten rather than lingering at 0.001 for the life of the scene.
 * A key that leaves and returns mid-fade resumes where it got to, which is
 * what stops a flickering membership from strobing. 0 means draw nothing.
 */
export class PresenceTracker {
  private readonly values = new Map<string, number>();
  constructor(
    /** Milliseconds to arrive and to leave. */
    private readonly inMs = 800,
    private readonly outMs = 3000,
  ) {}

  /** Advance toward this frame's membership; returns every value still drawn. */
  step(present: Iterable<string>, dt: number): ReadonlyMap<string, number> {
    const seconds = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const wanted: Set<string> =
      present instanceof Set ? (present as Set<string>) : new Set(present);
    const rising = seconds / (this.inMs / 1000);
    const falling = seconds / (this.outMs / 1000);
    for (const key of wanted)
      this.values.set(key, Math.min((this.values.get(key) ?? 0) + rising, 1));
    for (const [key, value] of this.values) {
      if (wanted.has(key)) continue;
      const faded = value - falling;
      if (faded <= 0) this.values.delete(key);
      else this.values.set(key, faded);
    }
    return this.values;
  }

  /** 0 for anything never seen or already forgotten. */
  get(key: string): number {
    return this.values.get(key) ?? 0;
  }

  /** Everything still being drawn, the departing included. */
  keys(): Iterable<string> {
    return this.values.keys();
  }

  clear(): void {
    this.values.clear();
  }
}
