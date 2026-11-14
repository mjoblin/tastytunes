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
    title: "Frozen Charlotte",
    artist: "Jack White",
    artUrl: `http://${EVO}:80/album-art-ea21?id=4:2`,
  }),
]);
const server = pool("nas", [
  node({
    title: "Frozen Charlotte",
    artist: "Jack White",
    artUrl: "http://192.168.0.101:26125/aa/5391/cover.jpg",
  }),
]);

describe("albumArtElsewhere", () => {
  it("finds the same album's cover in another library, never on the streamer's address", () => {
    expect(albumArtElsewhere([drive, server], "Jack White", "Frozen Charlotte", EVO)).toBe(
      "http://192.168.0.101:26125/aa/5391/cover.jpg",
    );
    expect(albumArtElsewhere([drive], "Jack White", "Frozen Charlotte", EVO)).toBeNull();
  });

  it("matches names as the library does (case and spacing), and by album artist", () => {
    const comp = pool("nas", [
      node({
        title: "frozen charlotte ",
        albumArtist: "JACK WHITE",
        artist: "Someone Else",
        artUrl: "http://192.168.0.101/c.jpg",
      }),
    ]);
    expect(albumArtElsewhere([comp], "Jack White", "Frozen Charlotte", EVO)).toBe(
      "http://192.168.0.101/c.jpg",
    );
  });

  it("falls back to a track of the album, and is nothing for another artist's album of that title", () => {
    const tracksOnly = pool(
      "nas",
      [],
      [
        node({
          title: "Derecho Demonico",
          album: "Frozen Charlotte",
          artist: "Jack White",
          isContainer: false,
          upnpClass: "object.item.audioItem.musicTrack",
          artUrl: "http://192.168.0.101/t.jpg",
        }),
      ],
    );
    expect(albumArtElsewhere([tracksOnly], "Jack White", "Frozen Charlotte", EVO)).toBe(
      "http://192.168.0.101/t.jpg",
    );
    expect(albumArtElsewhere([server], "Meg White", "Frozen Charlotte", EVO)).toBeNull();
  });
});
