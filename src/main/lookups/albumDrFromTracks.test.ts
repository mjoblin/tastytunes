import { describe, expect, it } from "vitest";
import {
  albumDr14,
  audioAnalysisKey,
  type AlbumDr,
  type MediaIndexPools,
  type MediaNode,
} from "@shared/model";
import { albumDrsFromTracks } from "./albumDrFromTracks";

const node = (over: Partial<MediaNode>): MediaNode => ({
  id: over.id ?? over.title ?? "x",
  parentId: null,
  title: "x",
  upnpClass: "object.container.album.musicAlbum",
  isContainer: true,
  artUrl: null,
  artist: null,
  album: null,
  year: null,
  trackNumber: null,
  durationSecs: null,
  ...over,
});
const album = (title: string, by: string, id = `al-${title}`): MediaNode =>
  node({ id, title, artist: by });
const track = (title: string, on: string, by: string, secs = 200): MediaNode =>
  node({
    id: `t-${on}-${title}`,
    title,
    album: on,
    artist: by,
    durationSecs: secs,
    isContainer: false,
    upnpClass: "object.item.audioItem.musicTrack",
  });
const pools = (albums: MediaNode[], tracks: MediaNode[]): MediaIndexPools[] => [
  { udn: "u", serverName: "s", albums, artists: [], tracks },
];
const sources = (
  drs: Record<string, number>,
  recorded: Record<string, AlbumDr> = {},
  hists: Record<string, number[]> = {},
) => ({
  recorded: new Map(Object.entries(recorded)),
  dr: (k: string) => drs[k],
  hist: (k: string) => hists[k],
});

describe("albumDrsFromTracks: an album's DR once its every track is measured", () => {
  const days = [
    track("Why Do Men Sing", "My Days of 58", "Bill Callahan", 418),
    track("Empathy", "My Days of 58", "Bill Callahan", 319),
    track("And Dream Land", "My Days of 58", "Bill Callahan", 265),
  ];
  const p = pools([album("My Days of 58", "Bill Callahan")], days);
  const k = days.map((t) => audioAnalysisKey(t));

  it("records the sweep's own number when every track is measured, a DR0 track included", () => {
    const out = albumDrsFromTracks(p, sources({ [k[0]]: 9, [k[1]]: 13, [k[2]]: 0 }), undefined, 7);
    expect(out).toEqual([
      {
        key: "bill callahan|my days of 58",
        entry: { dr: albumDr14([9, 13, 0]), tracks: 3, analyzedAt: 7, lufs: null },
      },
    ]);
  });
  it("records nothing while a track is unmeasured", () => {
    expect(albumDrsFromTracks(p, sources({ [k[0]]: 9, [k[1]]: 13 }))).toEqual([]);
  });
  it("leaves an album recorded at its track count, and records one recorded at another", () => {
    const drs = { [k[0]]: 9, [k[1]]: 13, [k[2]]: 8 };
    const at = (tracks: number): Record<string, AlbumDr> => ({
      "bill callahan|my days of 58": { dr: 10, tracks, analyzedAt: 1 },
    });
    expect(albumDrsFromTracks(p, sources(drs, at(3)))).toEqual([]);
    expect(albumDrsFromTracks(p, sources(drs, at(12)))[0]?.entry.tracks).toBe(3);
  });
  it("integrates the loudness when every track carries a histogram", () => {
    const h = Array.from({ length: 800 }, (_, i) => (i === 500 ? 10 : 0));
    const out = albumDrsFromTracks(
      p,
      sources({ [k[0]]: 9, [k[1]]: 13, [k[2]]: 8 }, {}, { [k[0]]: h, [k[1]]: h, [k[2]]: h }),
    );
    expect(out[0]?.entry.lufs).toBeTypeOf("number");
  });
  it("leaves same-keyed albums (twin editions, a drive's two folders) to the sweep", () => {
    const twins = pools(
      [
        album("Frozen Charlotte", "Jack White", "f1"),
        album("Frozen Charlotte", "Jack White", "f2"),
      ],
      [track("She's In A Frenzy", "Frozen Charlotte", "Jack White")],
    );
    const tk = audioAnalysisKey(track("She's In A Frenzy", "Frozen Charlotte", "Jack White"));
    expect(albumDrsFromTracks(twins, sources({ [tk]: 7 }))).toEqual([]);
  });
  it("with a track's key, looks only at the album holding it", () => {
    const other = [track("Solo", "Other", "Someone")];
    const both = pools(
      [album("My Days of 58", "Bill Callahan"), album("Other", "Someone")],
      [...days, ...other],
    );
    const drs = { [k[0]]: 9, [k[1]]: 13, [k[2]]: 8, [audioAnalysisKey(other[0])]: 6 };
    expect(albumDrsFromTracks(both, sources(drs), k[1]).map((x) => x.key)).toEqual([
      "bill callahan|my days of 58",
    ]);
    expect(albumDrsFromTracks(both, sources(drs)).length).toBe(2);
  });
});
