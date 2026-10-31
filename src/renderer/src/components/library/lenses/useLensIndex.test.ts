/**
 * The lenses' index over a pools snapshot: albums' tracks grouped by server and title in
 * disc order, every performer an artist, compilations by their performers, and one index
 * per snapshot. The names are placeholders chosen to show a shape.
 */
import { describe, expect, it } from "vitest";
import type { MediaIndexPools, MediaNode } from "@shared/model";
import { lensIndexOf } from "./useLensIndex";
import { LOSSLESS_TAG } from "./lensShared";

const node = (over: Partial<MediaNode>): MediaNode => ({
  id: over.id ?? over.title ?? "x",
  parentId: null,
  title: "x",
  upnpClass: "object.item.audioItem.musicTrack",
  isContainer: false,
  artUrl: null,
  artist: null,
  album: null,
  year: null,
  trackNumber: null,
  durationSecs: null,
  serverUdn: "s1",
  ...over,
});
const album = (title: string, artist: string): MediaNode =>
  node({
    id: `alb-${title}`,
    title,
    artist,
    isContainer: true,
    upnpClass: "object.container.album.musicAlbum",
  });

const pools: MediaIndexPools[] = [
  {
    udn: "s1",
    serverName: "One",
    albums: [album("Night Drive", "The Band"), album("Mixtape", "Various Artists")],
    artists: [],
    tracks: [
      node({ id: "t2", title: "Second", album: "Night Drive", artist: "The Band", trackNumber: 2 }),
      node({
        id: "t1",
        title: "First",
        album: "Night Drive",
        artist: "The Band; Guest Singer",
        artists: ["The Band", "Guest Singer"],
        trackNumber: 1,
      }),
      node({ id: "m1", title: "A", album: "Mixtape", artist: "Someone" }),
      node({ id: "m2", title: "B", album: "Mixtape", artist: "Someone Else" }),
    ],
  },
];

describe("lensIndexOf", () => {
  it("gives an album its own tracks, in disc and position order", () => {
    const ix = lensIndexOf(pools);
    expect(ix.tracksOf(pools[0].albums[0]).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(ix.albumKey(pools[0].albums[0])).toBe("s1|night drive");
    // a compilation's tracks credit their own performers, and it is alone under its title
    expect(ix.tracksOf(pools[0].albums[1]).map((t) => t.id)).toEqual(["m1", "m2"]);
  });

  it("keeps each copy's formats and each artist's album apart when two share a title", () => {
    const fmt = (codec: string) => ({ codec }) as MediaNode["format"];
    const shared: MediaIndexPools[] = [
      {
        udn: "s1",
        serverName: "One",
        albums: [
          { ...album("Hits", "Lead"), id: "h-flac", artUrl: "http://s/flac.jpg" },
          { ...album("Hits", "Lead"), id: "h-mp3", artUrl: "http://s/mp3.jpg" },
          { ...album("Hits", "Other"), id: "h-other" },
        ],
        artists: [],
        tracks: [
          node({
            id: "f1",
            album: "Hits",
            artist: "Lead",
            artUrl: "http://s/flac.jpg",
            format: fmt("FLAC"),
          }),
          node({
            id: "p1",
            album: "Hits",
            artist: "Lead",
            artUrl: "http://s/mp3.jpg",
            format: fmt("MP3"),
          }),
          node({ id: "o1", album: "Hits", artist: "Other", format: fmt("AAC") }),
        ],
      },
    ];
    const ix = lensIndexOf(shared);
    expect([...(ix.albumCodecs.get("s1|h-flac") ?? [])]).toEqual(["FLAC", LOSSLESS_TAG]);
    expect([...(ix.albumCodecs.get("s1|h-mp3") ?? [])]).toEqual(["MP3"]);
    expect([...(ix.albumCodecs.get("s1|h-other") ?? [])]).toEqual(["AAC"]);
    expect(ix.compilationKeys.size).toBe(0);
  });

  it("makes every performer an artist, never the packed string", () => {
    const names = lensIndexOf(pools).artists.map((a) => a.name);
    expect(names).toContain("Guest Singer");
    expect(names).not.toContain("The Band; Guest Singer");
    expect(lensIndexOf(pools).artists.find((a) => a.name === "The Band")?.albums).toHaveLength(1);
  });

  it("reads an artist's own picture as main does: a server picture that is a cover is not theirs", () => {
    const ix = lensIndexOf([
      {
        udn: "s1",
        serverName: "One",
        albums: [{ ...album("Covered", "Plain"), artUrl: "http://s/covered.jpg" }],
        artists: [
          {
            ...node({ id: "ar-plain", title: "Plain", isContainer: true }),
            artUrl: "http://s/covered.jpg",
          },
          {
            ...node({ id: "ar-real", title: "Real", isContainer: true }),
            artUrl: "http://s/userart.jpg",
          },
        ],
        tracks: [node({ id: "r1", album: "Loose", artist: "Real" })],
      },
    ]);
    const of = (name: string) => ix.artists.find((a) => a.name === name);
    expect(of("Plain")).toMatchObject({ ownArt: null, artUrl: "http://s/covered.jpg" });
    expect(of("Real")).toMatchObject({
      ownArt: "http://s/userart.jpg",
      artUrl: "http://s/userart.jpg",
    });
  });

  it("knows the compilations, and answers one index per snapshot", () => {
    const ix = lensIndexOf(pools);
    expect([...ix.compilationKeys]).toEqual(["s1|alb-Mixtape"]);
    expect(lensIndexOf(pools)).toBe(ix);
    expect(lensIndexOf([...pools])).not.toBe(ix);
  });
});
