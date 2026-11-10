import { describe, expect, it } from "vitest";
import { FEED_HITS, FeedHits } from "./feedHits";

const quiet = { kick: 0, snare: 0, hat: 0 };

describe("the feed's own hits, for a track with no onset list", () => {
  it("makes a typed hit for each drum whose transient clears its threshold", () => {
    const hits = new FeedHits().read({ kick: 0.8, snare: 0.1, hat: 0.5 }, 1000, 12.5);
    expect(hits).toEqual([
      { at: 12.5, strength: 0.8, type: "kick" },
      { at: 12.5, strength: 0.5, type: "hat" },
    ]);
  });

  it("makes nothing from a transient at or under the threshold", () => {
    const feed = new FeedHits();
    expect(feed.read(quiet, 0, 0)).toEqual([]);
    expect(feed.read({ ...quiet, kick: FEED_HITS.kick.over }, 1000, 1)).toEqual([]);
  });

  it("takes two of one drum closer than its gap as one, and keeps the drums apart", () => {
    const feed = new FeedHits();
    expect(feed.read({ ...quiet, kick: 0.9 }, 1000, 1)).toHaveLength(1);
    expect(
      feed.read({ kick: 0.9, snare: 0.9, hat: 0 }, 1000 + FEED_HITS.kick.gapMs - 1, 1.1),
    ).toEqual([{ at: 1.1, strength: 0.9, type: "snare" }]);
    expect(feed.read({ ...quiet, kick: 0.9 }, 1000 + FEED_HITS.kick.gapMs, 1.2)).toHaveLength(1);
  });

  it("makes none while held (after a seek, a new track or a resume), then as before", () => {
    const feed = new FeedHits();
    feed.hold(1000, 1400);
    const loud = { kick: 0.9, snare: 0.9, hat: 0.9 };
    expect(feed.read(loud, 1000, 5)).toEqual([]);
    expect(feed.read(loud, 2399, 5.1)).toEqual([]);
    expect(feed.read(loud, 2400, 5.2)).toHaveLength(3);
  });
});
