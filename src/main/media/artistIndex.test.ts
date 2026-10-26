import { describe, expect, it } from "vitest";
import type { MediaIndexPools, MediaNode } from "@shared/model";
import { artistIndex } from "./artistIndex";

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
const artist = (title: string, artUrl: string | null): MediaNode =>
  node({ id: `ar-${title}`, title, artUrl, upnpClass: "object.container.person.musicArtist" });
const album = (title: string, by: string, artUrl: string | null): MediaNode =>
  node({ id: `al-${title}`, title, artist: by, artUrl });
const track = (title: string, by: string, artUrl: string | null): MediaNode =>
  node({
    id: `t-${title}`,
    title,
    artist: by,
    artUrl,
    isContainer: false,
    upnpClass: "object.item.audioItem.musicTrack",
  });
const pools = (p: Partial<MediaIndexPools>): MediaIndexPools[] => [
  { udn: "u", serverName: "s", albums: [], artists: [], tracks: [], ...p },
];

describe("artistIndex: what the indexes know of an artist", () => {
  it("counts a server picture that is one of the albums' covers as a cover, not the artist's own", () => {
    // an Asset library: 370 of 371 artists carried one of their own album covers
    const m = artistIndex(
      pools({
        artists: [artist("Muse", "http://a/aa/1/cover.jpg")],
        albums: [album("The 2nd Law", "Muse", "http://a/aa/1/cover.jpg")],
      }),
    );
    expect(m.get("muse")).toMatchObject({ own: null, cover: "http://a/aa/1/cover.jpg" });
  });
  it("counts a server picture that is one of the tracks' covers as a cover too (MinimServer)", () => {
    // a user's server: each track carries its own embedded cover URL, and the artist's picture is one
    // of them, never the album container's own URL
    const pic = (n: number): string =>
      `http://m:9790/minimserver/*/Oscar*20Peterson/CD02/2-${n}*20Song.flac/$!picture-1730-300546.jpg`;
    const m = artistIndex(
      pools({
        artists: [artist("Oscar Peterson", pic(11))],
        albums: [album("Songbooks+", "Oscar Peterson", pic(1))],
        tracks: [
          track("Song", "Oscar Peterson", pic(1)),
          track("Close Your Eyes", "Oscar Peterson", pic(11)),
        ],
      }),
    );
    expect(m.get("oscar peterson")).toMatchObject({ own: null, cover: pic(1) });
  });

  it("keeps a server picture that is no album's cover as the artist's own", () => {
    const m = artistIndex(
      pools({
        artists: [artist("Muse", "http://a/aa/000BEB3A/userart.jpg")],
        albums: [album("The 2nd Law", "Muse", "http://a/aa/1/cover.jpg")],
      }),
    );
    expect(m.get("muse")?.own).toBe("http://a/aa/000BEB3A/userart.jpg");
  });
  it("takes a cover from an album, else from a track, for an artist with no picture", () => {
    const m = artistIndex(
      pools({
        albums: [album("Night Train", "Oscar Peterson", "http://a/night.jpg")],
        tracks: [track("Guest Spot", "Sleeper", "http://a/guest.jpg")],
      }),
    );
    expect(m.get("oscar peterson")?.cover).toBe("http://a/night.jpg");
    expect(m.get("sleeper")?.cover).toBe("http://a/guest.jpg");
  });
  it("counts as the Artists lens does: an album by its artist, a track by every performer", () => {
    const m = artistIndex(
      pools({
        albums: [album("A", "Muse", null), album("B", "Muse", null)],
        // the parser hands the performers over as a list (the packed "A; B" is the display)
        tracks: [
          track("1", "Muse", null),
          { ...track("2", "Muse; Guest", null), artists: ["Muse", "Guest"] },
        ],
      }),
    );
    expect(m.get("muse")).toMatchObject({ albums: 2, tracks: 2 });
    expect(m.get("guest")).toMatchObject({ albums: 0, tracks: 1 });
  });
  it("answers the same map for the same pools snapshot", () => {
    const p = pools({ albums: [album("A", "Muse", null)] });
    expect(artistIndex(p)).toBe(artistIndex(p));
  });
});
