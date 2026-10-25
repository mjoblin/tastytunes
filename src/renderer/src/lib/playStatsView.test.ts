import { describe, expect, it } from "vitest";
import {
  type ListeningPlayEvent,
  type MediaNode,
  emptyPlayStats,
  foldPlayEvent,
} from "@shared/model";
import {
  EMPTY_VIEW,
  PLAYED_LABELS,
  playedBucket,
  playedOptionsOf,
  talliesOf,
  viewOf,
} from "./playStatsView";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 24);

const track = (n: number, over: Partial<MediaNode> = {}): MediaNode => ({
  id: `t${n}`,
  parentId: "alb",
  title: `Track ${n}`,
  upnpClass: "object.item.audioItem.musicTrack",
  isContainer: false,
  artUrl: null,
  artist: "Band",
  album: "Record",
  year: null,
  trackNumber: n,
  durationSecs: 200,
  serverUdn: "uuid:nas",
  ...over,
});

const play = (
  t: MediaNode,
  at: number,
  over: Partial<ListeningPlayEvent> = {},
): ListeningPlayEvent => ({
  v: 1,
  at,
  tzOffsetMin: 0,
  kind: "play",
  title: t.title,
  artist: t.artist,
  album: t.album,
  playedSeconds: 200,
  duration: t.durationSecs,
  codec: "FLAC",
  sampleRate: 44100,
  bitDepth: 16,
  lossless: true,
  source: null,
  sourceId: "MEDIA_PLAYER",
  ...over,
});

describe("viewOf: the record as the Library reads it", () => {
  it("has nothing to say with no stats", () => {
    expect(viewOf(null)).toBe(EMPTY_VIEW);
    expect(EMPTY_VIEW.ready).toBe(false);
  });

  it("makes an album's tally the fold of its tracks, and counts a run that heard them all", () => {
    const tracks = [track(1), track(2), track(3)];
    const stats = emptyPlayStats();
    // a whole listen an hour ago, then track 1 again
    for (const [i, t] of tracks.entries())
      foldPlayEvent(stats, play(t, NOW - 3_600_000 + i * 205_000));
    foldPlayEvent(stats, play(tracks[0], NOW - 600_000 + 3 * 205_000));
    const album = viewOf(stats).album(tracks);
    expect(album.plays).toBe(4);
    expect(album.whole).toBe(1);
    expect(album.lastAt).toBe(NOW - 600_000 + 3 * 205_000);
  });

  it("counts a whole listen only on the copy it was played from", () => {
    const art = (side: string): string => `http://nas/${side}/folder.jpg`;
    const us = [track(1, { artUrl: art("US") }), track(2, { artUrl: art("US") })];
    const jp = [
      track(1, { id: "j1", artUrl: art("JP") }),
      track(2, { id: "j2", artUrl: art("JP") }),
    ];
    const stats = emptyPlayStats();
    for (const [i, t] of jp.entries())
      foldPlayEvent(
        stats,
        play(t, NOW - 3_600_000 + i * 205_000, { artUrl: art("JP"), artHost: "nas" }),
      );
    const view = viewOf(stats, () => [...us, ...jp]);
    expect(view.album(jp).whole).toBe(1);
    expect(view.album(us).whole).toBe(0);
  });

  it("reads each row's tally once for a sort", () => {
    const tracks = [track(1), track(2)];
    const stats = emptyPlayStats();
    foldPlayEvent(stats, play(tracks[1], NOW - DAY));
    const tally = talliesOf(viewOf(stats), tracks);
    expect(tally.get(tracks[0])).toBeNull();
    expect(tally.get(tracks[1])?.plays).toBe(1);
  });
});

describe("the Played facet", () => {
  it("has four fixed buckets, by the most recent play", () => {
    expect(playedBucket(null, NOW)).toBe("never");
    expect(playedBucket(NOW - 2 * DAY, NOW)).toBe("week");
    expect(playedBucket(NOW - 10 * DAY, NOW)).toBe("month");
    expect(playedBucket(NOW - 60 * DAY, NOW)).toBe("older");
    expect(PLAYED_LABELS.never).toBe("Unplayed");
  });

  it("offers a bucket only when it would narrow the list, in fixed order", () => {
    const options = playedOptionsOf([null, NOW - DAY, NOW - DAY, NOW - 60 * DAY], NOW);
    expect(options.map((o) => o.value)).toEqual(["never", "week", "older"]);
    expect(options.find((o) => o.value === "week")?.count).toBe(2);
    // every item in one bucket: nothing to narrow
    expect(playedOptionsOf([NOW - DAY, NOW - 2 * DAY], NOW)).toEqual([]);
  });
});
