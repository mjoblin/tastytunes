/**
 * The Library doors' pictures: the most played first, a fixed order without a record, one album
 * on two servers drawn once, never a compilation's "Various Artists", and waveforms read from
 * the stored envelope.
 */
import { describe, expect, it } from "vitest";
import { type MediaIndexPools, type MediaNode, type PlayStat, playKey } from "@shared/model";
import { DOOR_ITEMS, faceOrder, monogram, pickDoorArt, waveBars } from "./doorPicks";

const node = (n: Partial<MediaNode> & { title: string }): MediaNode => ({
  id: n.title,
  parentId: null,
  upnpClass: "object.item.audioItem.musicTrack",
  isContainer: false,
  artUrl: null,
  artist: null,
  album: null,
  year: null,
  trackNumber: null,
  durationSecs: 200,
  ...n,
});
const album = (title: string, artist: string, art = true): MediaNode =>
  node({
    title,
    artist,
    isContainer: true,
    upnpClass: "object.container.album.musicAlbum",
    artUrl: art ? `http://x/${title}.jpg` : null,
  });
const track = (title: string, artist: string, albumTitle: string, extra: Partial<MediaNode> = {}) =>
  node({ title, artist, album: albumTitle, ...extra });
const pool = (
  albums: MediaNode[],
  tracks: MediaNode[],
  artists: string[] = [],
): MediaIndexPools => ({
  udn: "uuid:a",
  serverName: "a",
  albums,
  tracks,
  artists: artists.map((a) => node({ title: a, isContainer: true })),
});
const record =
  (plays: Record<string, number>) =>
  (t: MediaNode): PlayStat | null => {
    const n = plays[playKey(t.title, t.artist, t.album)];
    return n ? ({ plays: n, lastAt: 1 } as PlayStat) : null;
  };

describe("the doors' picks", () => {
  const albums = [
    "Disintegration",
    "Pornography",
    "Faith",
    "Seventeen Seconds",
    "Wish",
    "Bloodflowers",
  ].map((t) => album(t, "The Cure"));
  const tracks = [
    track("Plainsong", "The Cure", "Disintegration"),
    track("Pictures of You", "The Cure", "Disintegration"),
    track("One Hundred Years", "The Cure", "Pornography"),
    track("A Forest", "The Cure", "Seventeen Seconds"),
    track("Friday I'm in Love", "The Cure", "Wish"),
  ];

  it("puts the most played album first, summing its tracks", () => {
    const picks = pickDoorArt(
      [pool(albums, tracks)],
      record({
        [playKey("Plainsong", "The Cure", "Disintegration")]: 2,
        [playKey("Pictures of You", "The Cure", "Disintegration")]: 3,
        [playKey("A Forest", "The Cure", "Seventeen Seconds")]: 4,
        [playKey("One Hundred Years", "The Cure", "Pornography")]: 1,
      }),
    );
    expect(picks.covers.map((a) => a.title).slice(0, 3)).toEqual([
      "Disintegration",
      "Seventeen Seconds",
      "Pornography",
    ]);
    expect(picks.covers).toHaveLength(DOOR_ITEMS);
    expect(picks.tracks[0].title).toBe("A Forest");
  });

  it("draws the same doors every time without a record", () => {
    const a = pickDoorArt([pool(albums, tracks)], () => null);
    const b = pickDoorArt([pool([...albums].reverse(), [...tracks].reverse())], () => null);
    expect(a.covers.map((x) => x.title)).toEqual(b.covers.map((x) => x.title));
    expect(a.tracks.map((x) => x.title)).toEqual(b.tracks.map((x) => x.title));
  });

  it("draws an album on two servers once", () => {
    const picks = pickDoorArt(
      [pool(albums, []), { ...pool(albums, []), udn: "uuid:b" }],
      () => null,
    );
    expect(new Set(picks.covers.map((a) => a.title)).size).toBe(picks.covers.length);
  });

  it("takes covers only for the crate and any album for the sleeves", () => {
    const bare = ["One", "Two", "Three"].map((t) => album(t, "Someone", false));
    const picks = pickDoorArt([pool([...bare, album("Four", "Someone")], [])], () => null);
    expect(picks.covers.map((a) => a.title)).toEqual(["Four"]);
    expect(picks.sleeves).toHaveLength(4);
  });

  it("names the played artists first, a compilation's performer rather than Various Artists", () => {
    const comp = track("Song", "Kate Bush", "Hits", { albumArtist: "Various Artists" });
    const picks = pickDoorArt(
      [pool([album("Hits", "Various Artists")], [comp, ...tracks], ["Various Artists", "Björk"])],
      record({
        [playKey("Song", "Kate Bush", "Hits")]: 9,
        [playKey("A Forest", "The Cure", "Seventeen Seconds")]: 1,
      }),
    );
    expect(picks.artists.slice(0, 2)).toEqual(["Kate Bush", "The Cure"]);
    expect(picks.artists).toContain("Björk");
    expect(picks.artists).not.toContain("Various Artists");
  });

  it("offers each track's analysis once", () => {
    const twice = [tracks[0], { ...tracks[0], id: "other" }];
    expect(pickDoorArt([pool([], twice)], () => null).tracks).toHaveLength(1);
  });
});

describe("the Artists door's faces", () => {
  it("stands the photos in front of the covers, each in the order of plays", () => {
    const covers = new Set(["cover:keane", "cover:cure"]);
    const faces = [
      { name: "Keane", pic: "cover:keane" },
      { name: "Kacey Musgraves", pic: "photo:kacey" },
      { name: "The Cure", pic: "cover:cure" },
      { name: "Syndicate", pic: null },
      { name: "Björk", pic: "photo:bjork" },
    ];
    expect(faceOrder(faces, covers).map((f) => f.name)).toEqual([
      "Kacey Musgraves",
      "Björk",
      "Keane",
      "The Cure",
      "Syndicate",
    ]);
  });
});

describe("the Tracks door's waveform", () => {
  it("keeps each slice's loudest moment, against the track's own peak", () => {
    expect(waveBars([0, 250, 500, 1000], 2)).toEqual([0.25, 1]);
    expect(waveBars([0, 0], 2)).toEqual([0, 0]);
    expect(waveBars([], 4)).toEqual([]);
    expect(waveBars([100, 200, 300], 64)).toHaveLength(64);
  });
});

describe("an artist's monogram", () => {
  it("takes the first letters of two words, a leading The and the joining words dropped", () => {
    expect(monogram("The Cure")).toBe("C");
    expect(monogram("Kate Bush")).toBe("KB");
    expect(monogram("Siouxsie and the Banshees")).toBe("SB");
    expect(monogram("Echo & the Bunnymen")).toBe("EB");
    expect(monogram("!!!")).toBe("!");
    expect(monogram("")).toBe("");
    expect(monogram("Ólafur Arnalds")).toBe("ÓA");
  });
});
