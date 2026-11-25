import { describe, expect, it } from "vitest";
import type { MediaIndexPools, MediaNode } from "@shared/model";
import { albumArtElsewhere } from "./albumArtElsewhere";

const node = (f: Partial<MediaNode>): MediaNode => ({
  id: f.id ?? "x",
  parentId: null,
  title: "",
  upnpClass: "object.container.album.musicAlbum",
  isContainer: true,
  artist: null,
  album: null,
  year: null,
  trackNumber: null,
  durationSecs: null,
  artUrl: null,
  ...f,
});
const pool = (udn: string, albums: MediaNode[], tracks: MediaNode[] = []): MediaIndexPools => ({
  udn,
  serverName: udn,
  albums,
  artists: [],
  tracks,
});

const EVO = "192.168.0.45";
const drive = pool("usb", [
  node({
    title: "Paper Moons",
    artist: "Glass Orchard",
    artUrl: `http://${EVO}:80/album-art-ea21?id=4:2`,
  }),
]);
const server = pool("nas", [
  node({
    title: "Paper Moons",
    artist: "Glass Orchard",
    artUrl: "http://192.168.0.101:26125/aa/5391/cover.jpg",
  }),
]);

describe("albumArtElsewhere", () => {
  it("offers nothing on the failed picture's server, a track's beside it included", () => {
    const own = "http://192.168.0.101:26125/aa/5391/cover.jpg";
    const sameServerTrack = pool(
      "nas-tracks",
      [],
      [
        node({
          title: "Harbour Lights",
          album: "Paper Moons",
          artist: "Glass Orchard",
          isContainer: false,
          upnpClass: "object.item.audioItem.musicTrack",
          artUrl: "http://192.168.0.101:26125/aa/5392/cover.jpg",
        }),
      ],
    );
    expect(
      albumArtElsewhere([server, sameServerTrack], "Glass Orchard", "Paper Moons", EVO, own),
    ).toBeNull();
    expect(
      albumArtElsewhere([server], "Glass Orchard", "Paper Moons", EVO, `${own}?size=480`),
    ).toBeNull();
    // another server's copy is offered
    const other = pool("other", [
      node({ title: "Paper Moons", artist: "Glass Orchard", artUrl: "http://192.168.0.102/p.jpg" }),
    ]);
    expect(albumArtElsewhere([server, other], "Glass Orchard", "Paper Moons", EVO, own)).toBe(
      "http://192.168.0.102/p.jpg",
    );
    expect(
      albumArtElsewhere([server], "Glass Orchard", "Paper Moons", EVO, "http://elsewhere/x.jpg"),
    ).toBe(own);
  });

  it("finds the same album's cover in another library, never on the streamer's address", () => {
    expect(albumArtElsewhere([drive, server], "Glass Orchard", "Paper Moons", EVO)).toBe(
      "http://192.168.0.101:26125/aa/5391/cover.jpg",
    );
    expect(albumArtElsewhere([drive], "Glass Orchard", "Paper Moons", EVO)).toBeNull();
  });

  it("matches names as the library does (case and spacing), and by album artist", () => {
    const comp = pool("nas", [
      node({
        title: "paper moons ",
        albumArtist: "GLASS ORCHARD",
        artist: "Someone Else",
        artUrl: "http://192.168.0.101/c.jpg",
      }),
    ]);
    expect(albumArtElsewhere([comp], "Glass Orchard", "Paper Moons", EVO)).toBe(
      "http://192.168.0.101/c.jpg",
    );
  });

  it("falls back to a track of the album, and is nothing for another artist's album of that title", () => {
    const tracksOnly = pool(
      "nas",
      [],
      [
        node({
          title: "Harbour Lights",
          album: "Paper Moons",
          artist: "Glass Orchard",
          isContainer: false,
          upnpClass: "object.item.audioItem.musicTrack",
          artUrl: "http://192.168.0.101/t.jpg",
        }),
      ],
    );
    expect(albumArtElsewhere([tracksOnly], "Glass Orchard", "Paper Moons", EVO)).toBe(
      "http://192.168.0.101/t.jpg",
    );
    expect(albumArtElsewhere([server], "Dusk Parade", "Paper Moons", EVO)).toBeNull();
  });
});
