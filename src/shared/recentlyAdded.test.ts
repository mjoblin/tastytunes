import { describe, expect, it } from "vitest";
import type { MediaNode } from "./model/media";
import {
  arrivalKey,
  compareRecentlyAdded,
  isRecentListTitle,
  mayHoldRecentList,
  recentEntriesOf,
  recentlyAdded,
  recentRanks,
} from "./recentlyAdded";

const node = (over: Partial<MediaNode>): MediaNode => ({
  id: over.title ?? "x",
  parentId: "0",
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

describe("a server's own list, by its name", () => {
  it("is found among the names the surveyed servers use, and nothing else", () => {
    // Asset, Gerbera, Emby and Jellyfin, MiniDLNA and UMS, from the 2026-08 survey
    const asset = [
      "Album Artist",
      "Album",
      "Title",
      "Composer",
      "Genre",
      "Dynamic Browsing",
      "TuneIn Internet Radio",
      "Additional",
      "New Albums",
      "Jukebox Track Selection",
      "Top Artists",
      "Top Albums",
    ];
    const gerbera = [
      "PC Directory",
      "Audio",
      "Photos",
      "Music Recently Played",
      "Recently Modified",
      "Recently Added",
    ];
    const emby = [
      "Latest",
      "Playlists",
      "Albums",
      "Album Artists",
      "Artists",
      "Songs",
      "Genres",
      "Favorite Artists",
      "Favorite Albums",
      "Favorite Songs",
      "Folders",
    ];
    const minidlna = [
      "Album",
      "All Music",
      "Artist",
      "Folders",
      "Genre",
      "Playlists",
      "Recently Added",
    ];
    expect(asset.filter(isRecentListTitle)).toEqual(["New Albums"]);
    expect(gerbera.filter(isRecentListTitle)).toEqual(["Recently Added"]);
    expect(emby.filter(isRecentListTitle)).toEqual(["Latest"]);
    expect(minidlna.filter(isRecentListTitle)).toEqual(["Recently Added"]);
    expect(isRecentListTitle("[Recently Added]")).toBe(true);
    expect(isRecentListTitle("  recently   added ")).toBe(true);
    expect(isRecentListTitle("Recently Played")).toBe(false);
  });

  it("is looked for one level down under Music, Audio and Media Library only", () => {
    expect(
      ["Music", "Audio", "Media Library", "Browse Folders", "Photos", "media"].filter(
        mayHoldRecentList,
      ),
    ).toEqual(["Music", "Audio", "Media Library"]);
  });
});

describe("a server's list as albums", () => {
  it("takes album containers as they are, and groups tracks into their albums in order", () => {
    const albums = [
      node({ title: "Bootleg", artist: "The Garden", artUrl: "http://h/aa/1/cover.jpg" }),
    ];
    expect(recentEntriesOf(albums)).toEqual([
      { loose: "bootleg|the garden", art: "/aa/1/cover.jpg" },
    ]);
    const track = (title: string, album: string, artist: string): MediaNode =>
      node({
        title,
        album,
        artist,
        isContainer: false,
        upnpClass: "object.item.audioItem.musicTrack",
      });
    const tracks = [
      track("a1", "Second", "B"),
      track("a2", "Second", "B"),
      track("b1", "First", "A"),
      track("a3", "Second", "B"),
    ];
    expect(recentEntriesOf(tracks).map((e) => e.loose)).toEqual(["second|b", "first|a"]);
    expect(recentEntriesOf(tracks, 1)).toHaveLength(1);
  });

  it("ranks the index's albums by title and artist, an edition by the picture the list shows", () => {
    const us = node({ title: "Record", artist: "Band", artUrl: "http://h/aa/us/cover.jpg" });
    const jp = node({ title: "Record", artist: "Band", artUrl: "http://h/aa/jp/cover.jpg" });
    const other = node({ title: "Other", artist: "Band" });
    const ranks = recentRanks(
      [us, jp, other],
      [
        { loose: "other|band", art: "" },
        { loose: "record|band", art: "/aa/jp/cover.jpg" },
      ],
    );
    expect([...ranks.entries()]).toEqual([
      [2, 0],
      [1, 1],
    ]);
    // no picture to tell them apart: both editions take the rank
    expect(recentRanks([us, jp], [{ loose: "record|band", art: "" }]).size).toBe(2);
  });
});

describe("an album's arrival key", () => {
  it("is its title and artist, with its picture's path where the server keeps addresses", () => {
    const a = node({
      title: "Bootleg",
      artist: "The Garden",
      artUrl: "http://192.168.50.101:26125/aa/7/cover.jpg",
    });
    expect(arrivalKey(a, true)).toBe("bootleg|the garden|/aa/7/cover.jpg");
    expect(arrivalKey(a, false)).toBe("bootleg|the garden");
    expect(arrivalKey({ ...a, albumArtist: "Various" }, false)).toBe("bootleg|various");
  });
});

describe("the order", () => {
  it("is the dated newest first, then the server's list in its order, then the rest by title", () => {
    const albums = [
      node({ title: "Zed" }),
      node({ title: "Ranked Second", recentRank: 1 }),
      node({ title: "Old Dated", addedAt: 100 }),
      node({ title: "Ranked First", recentRank: 0 }),
      node({ title: "New Dated", addedAt: 200 }),
      node({ title: "Alpha" }),
    ];
    expect([...albums].sort(compareRecentlyAdded).map((a) => a.title)).toEqual([
      "New Dated",
      "Old Dated",
      "Ranked First",
      "Ranked Second",
      "Alpha",
      "Zed",
    ]);
    expect(recentlyAdded(albums).map((a) => a.title)).toEqual([
      "New Dated",
      "Old Dated",
      "Ranked First",
      "Ranked Second",
    ]);
  });
});
