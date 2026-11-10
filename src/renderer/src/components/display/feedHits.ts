// THE FEED'S OWN HITS (0.15.0, his A on the decision page "Hygiene Pass Decisions"). With no onset
// list (radio, AirPlay, an analysis from before onsets), a kick, a snare and a hat are read off the
// live signal's transients, the bass band's, the mids' and the highs', each over its threshold and
// past its gap. Every scene draws from typed hits the one way, where seven used to improvise each
// with its own threshold and four drew nothing at all.
import type { SceneHit } from "./scenes/types";

type Drum = SceneHit["type"];

/** What each drum's transient (0..1 above its slow average) must clear, and how close two may be. */
export const FEED_HITS: Record<Drum, { over: number; gapMs: number }> = {
  kick: { over: 0.4, gapMs: 140 },
  snare: { over: 0.35, gapMs: 140 },
  hat: { over: 0.3, gapMs: 90 },
};

export class FeedHits {
  private lastAt: Record<Drum, number> = { kick: -Infinity, snare: -Infinity, hat: -Infinity };
  private quietUntil = -Infinity;

  /** Make no hits for `ms` from `now`: after a seek, a new track or a resume the slow average
   *  behind every transient lags the music, and every band would read as a hit (0.15.0, his
   *  "mute the hits after a seek"). */
  hold(now: number, ms: number): void {
    this.quietUntil = now + ms;
  }

  /** The hits one fresh reading makes: `heard` is each drum's transient, `now` the frame's
   *  milliseconds, `at` the track seconds the hits are stamped with. */
  read(heard: Record<Drum, number>, now: number, at: number): SceneHit[] {
    const hits: SceneHit[] = [];
    if (now < this.quietUntil) return hits;
    for (const type of ["kick", "snare", "hat"] as const) {
      const { over, gapMs } = FEED_HITS[type];
      if (heard[type] > over && now - this.lastAt[type] >= gapMs) {
        this.lastAt[type] = now;
        hits.push({ at, strength: heard[type], type });
      }
    }
    return hits;
  }
}
