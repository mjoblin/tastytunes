import { describe, expect, it } from "vitest";
import {
  type Favorite,
  type MediaIndexPools,
  type PlayStats,
  emptyPlayStats,
  foldPlayEvent,
  heartOf,
  heartPeersFrom,
  peersByPlayKey,
  titleIndexOf,
} from "@shared/model";
import { shelvesFor } from "@shared/rediscover";
import { scaleLibrary, scaleRecord } from "@shared/scaleFixture";
import { talliesOf, viewOf } from "@/lib/playStatsView";
import { lensIndexOf } from "./useLensIndex";

// THE LIBRARY AT 50,000 TRACKS (0.13.0 round 2; the 0.11 re-score: "nothing proves the app above
// 5,000 tracks"). The work each Library surface does on its data, run on the scale fixture at
// 5,000 and at 50,000 tracks. Each is held to growing about as the library does (ten times the
// tracks may cost up to 25 times the time, where a step that compares every track with every
// other costs 100: the first run caught History's Rediscover shelves at 62) and to a time at
// 50,000 about six times what his Mac takes (2026-10-24, in ms: the index 43, every album's
// tracks and chip 36, a 20,000-play record 63, every tally and the plays sort 300, the hearts 31,
// the shelves 84), headroom for slower CI machines.

const NOW = Date.UTC(2026, 9, 24);
const small = scaleLibrary(5_000);
const large = scaleLibrary(50_000);
const record = (pools: MediaIndexPools[]): PlayStats => {
  const stats = emptyPlayStats();
  for (const e of scaleRecord(pools, 20_000, NOW)) foldPlayEvent(stats, e);
  return stats;
};

/** The best of three runs, in ms: one slow run is the machine, not the code. */
function timed(run: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    run();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

/** Times a step at both sizes and holds it to its budget and to near-linear growth. */
function scales(step: (pools: MediaIndexPools[]) => unknown, budgetMs: number): void {
  const t5 = Math.max(
    timed(() => step(small)),
    1,
  );
  const t50 = timed(() => step(large));
  expect(t50, `${t50.toFixed(0)} ms at 50,000 tracks`).toBeLessThan(budgetMs);
  expect(t50 / t5, `${(t50 / t5).toFixed(1)}x from 5,000 to 50,000`).toBeLessThan(25);
}

describe("the Library at 50,000 tracks", () => {
  it("the fixture is the size it says, with its copies", () => {
    expect(large[0].tracks).toHaveLength(50_000);
    expect(large[0].albums).toHaveLength(5_000);
    const twins = large[0].albums.filter((a) => a.title === "Scale Album 99");
    expect(twins).toHaveLength(2);
  });

  it("builds the lens index: albums, tracks, each album's tracks, artists, formats", () => {
    scales((pools) => {
      const index = lensIndexOf([...pools]);
      void index.artists;
      void index.albumCodecs;
      void index.compilationKeys;
      void index.albumGenres;
      void index.trackDecades;
    }, 300);
  });

  it("finds every album's own tracks and its copy chip", () => {
    const chip = lensIndexOf([...large]).copyBadge(
      large[0].albums.find((a) => a.id === "scl-100") ?? large[0].albums[0],
    );
    expect(chip).toBe("FLAC · 24/96");
    scales((pools) => {
      const index = lensIndexOf([...pools]);
      for (const a of index.albums) {
        index.tracksOf(a);
        index.copyBadge(a);
      }
    }, 300);
  });

  it("folds a 20,000-play record into its stats", () => {
    scales((pools) => record(pools), 500);
  });

  it("reads every album's tally and sorts every track by plays, each copy its own", () => {
    const statsSmall = record(small);
    const statsLarge = record(large);
    scales((pools) => {
      const view = viewOf(pools === small ? statsSmall : statsLarge, peersByPlayKey(pools));
      const index = lensIndexOf([...pools]);
      for (const a of index.albums) view.album(index.tracksOf(a));
      const tally = talliesOf(view, index.tracks);
      [...index.tracks].sort((x, y) => (tally.get(y)?.plays ?? 0) - (tally.get(x)?.plays ?? 0));
    }, 2_000);
  });

  it("answers whether each album is hearted against a thousand hearts", () => {
    const heartsOf = (pools: MediaIndexPools[]): Favorite[] =>
      pools[0].albums.slice(0, 1_000).map((a, i) => ({
        kind: "album",
        addedAt: i,
        title: a.title,
        artist: a.artist,
        album: null,
        artUrl: a.artUrl,
        serverUdn: a.serverUdn ?? null,
        serverName: a.serverName ?? null,
        objectId: a.id,
        titlePath: null,
      }));
    const hearts = { small: heartsOf(small), large: heartsOf(large) };
    scales((pools) => {
      const favs = pools === small ? hearts.small : hearts.large;
      const peersOf = heartPeersFrom(pools);
      for (const a of pools[0].albums) {
        const item = { ...a, kind: "album" as const, album: null, serverUdn: a.serverUdn ?? null };
        heartOf(item, favs, peersOf(item));
      }
    }, 300);
  });

  it("builds History's Rediscover shelves and the in-library title index", () => {
    const statsSmall = record(small);
    const statsLarge = record(large);
    scales((pools) => {
      shelvesFor(pools, pools === small ? statsSmall : statsLarge, NOW);
      titleIndexOf(pools);
    }, 600);
  });
});
