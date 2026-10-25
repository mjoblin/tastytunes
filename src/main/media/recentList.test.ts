import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaNode } from "@shared/model";

// The search for a server's list, walked over trees shaped as the surveyed servers' are (2026-08).
let tree: Record<string, MediaNode[]> = {};
const asked: string[] = [];
let setting: Record<string, unknown> = {};
vi.mock("./upnpBrowser", () => ({
  browseChildrenOf: vi.fn((_host: string, _udn: string, id: string) => {
    asked.push(id);
    return Promise.resolve(tree[id] ?? "missing");
  }),
}));
vi.mock("../data/persist", () => ({
  getSettings: () => ({ recentlyAddedLists: setting }),
}));
const { findRecentList, readRecentList } = await import("./recentList");

const box = (id: string, title: string): MediaNode => ({
  id,
  parentId: "0",
  title,
  upnpClass: "object.container",
  isContainer: true,
  artUrl: null,
  artist: null,
  album: null,
  year: null,
  trackNumber: null,
  durationSecs: null,
});
const albumIn = (title: string, artist: string): MediaNode => ({
  ...box(title, title),
  upnpClass: "object.container.album.musicAlbum",
  artist,
});
const server = { udn: "uuid:s", isStreamer: false, searchable: true };

beforeEach(() => {
  asked.length = 0;
  setting = {};
});

describe("a server's own Recently added list", () => {
  it("is at the top on Asset and Gerbera", async () => {
    tree = { "0": [box("a", "Album"), box("n", "New Albums"), box("t", "Top Albums")] };
    expect(await findRecentList("h", "uuid:s")).toEqual({
      id: "n",
      title: "New Albums",
      titlePath: ["New Albums"],
    });
    expect(asked).toEqual(["0"]);
  });

  it("is under Music on Emby, Jellyfin and MiniDLNA, and under Media Library's Audio on UMS", async () => {
    tree = { "0": [box("m", "Music")], m: [box("l", "Latest"), box("al", "Albums")] };
    expect((await findRecentList("h", "uuid:s"))?.titlePath).toEqual(["Music", "Latest"]);
    tree = {
      "0": [box("ml", "Media Library"), box("media", "media")],
      ml: [box("v", "Video"), box("au", "Audio")],
      au: [box("ra", "Recently Added"), box("rp", "Recently Played")],
    };
    expect((await findRecentList("h", "uuid:s"))?.titlePath).toEqual([
      "Media Library",
      "Audio",
      "Recently Added",
    ]);
  });

  it("is not looked for in folders of music, and none is none", async () => {
    tree = { "0": [box("f1", "Daft Punk"), box("f2", "GUNSHIP")] };
    expect(await findRecentList("h", "uuid:s")).toBeNull();
    expect(asked).toEqual(["0"]);
  });

  it("is read as albums in its order; off when turned off; the chosen one found again by its folders", async () => {
    tree = {
      "0": [box("n", "New Albums")],
      n: [albumIn("Bootleg", "The Garden"), albumIn("Superbloom", "Jessie Ware")],
    };
    const read = await readRecentList("h", server);
    expect(read.list?.title).toBe("New Albums");
    expect(read.chosen).toBe(false);
    expect(read.entries.map((e) => e.loose)).toEqual([
      "bootleg|the garden",
      "superbloom|jessie ware",
    ]);
    setting = { "uuid:s": "off" };
    expect(await readRecentList("h", server)).toEqual({
      list: null,
      chosen: false,
      off: true,
      entries: [],
    });
    // chosen by the reader, its id since re-minted: found again by its folders' titles
    tree = {
      "0": [box("x9", "Mine")],
      x9: [box("y9", "Fresh")],
      y9: [albumIn("Bootleg", "The Garden")],
    };
    setting = { "uuid:s": { id: "y1", title: "Fresh", titlePath: ["Mine", "Fresh"] } };
    const chosen = await readRecentList("h", server);
    expect(chosen.chosen).toBe(true);
    expect(chosen.entries).toHaveLength(1);
  });

  it("is never asked of the streamer's USB drive", async () => {
    tree = { "0": [box("n", "New Albums")] };
    expect(
      (await readRecentList("h", { udn: "uuid:usb", isStreamer: true, searchable: false })).list,
    ).toBeNull();
    expect(asked).toEqual([]);
  });
});
