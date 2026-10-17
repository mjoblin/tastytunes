/**
 * The lenses' index over a pools snapshot: albums' tracks grouped by server and title in
 * disc order, every performer an artist, compilations by their performers, and one index
 * per snapshot. The names are placeholders chosen to show a shape.
 */
import { describe, expect, it } from "vitest";
import type { MediaIndexPools, MediaNode } from "@shared/model";
import { lensIndexOf } from "./useLensIndex";

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
  it("groups an album's tracks by server and title, in disc and position order", () => {
    const ix = lensIndexOf(pools);
    expect(ix.tracksByAlbum.get("s1|night drive")?.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(ix.albumKey(pools[0].albums[0])).toBe("s1|night drive");
  });

  it("makes every performer an artist, never the packed string", () => {
    const names = lensIndexOf(pools).artists.map((a) => a.name);
    expect(names).toContain("Guest Singer");
    expect(names).not.toContain("The Band; Guest Singer");
    expect(lensIndexOf(pools).artists.find((a) => a.name === "The Band")?.albums).toHaveLength(1);
  });

  it("knows the compilations, and answers one index per snapshot", () => {
    const ix = lensIndexOf(pools);
    expect([...ix.compilationKeys]).toEqual(["s1|alb-Mixtape"]);
    expect(lensIndexOf(pools)).toBe(ix);
    expect(lensIndexOf([...pools])).not.toBe(ix);
  });
});
