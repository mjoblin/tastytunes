import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PLAYLISTS,
  MAX_PLAYLIST_ITEMS,
  PLAYLISTS_FULL,
  type PlaylistItem,
  playlistFullSentence,
  playlistTooLong,
} from "@shared/model";
import {
  PlaylistFullError,
  appendToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylists,
} from "./playlists";

const item = (n: number): PlaylistItem => ({
  title: `Track ${n}`,
  artist: "Glass Orchard",
  album: "Paper Moons",
  artUrl: null,
  serverUdn: null,
  serverName: null,
  objectId: null,
  durationSecs: 200,
});
const items = (count: number, from = 0): PlaylistItem[] =>
  Array.from({ length: count }, (_, i) => item(from + i));
const onDisk = (): unknown[] =>
  JSON.parse(readFileSync(join(app.getPath("userData"), "playlists.json"), "utf-8")) as unknown[];

// one file, so the order matters: the collection fills, then is held at its bound
describe("a playlist write past a bound is refused, never trimmed", () => {
  it("refuses a playlist longer than the bound, and an add that would make one", () => {
    expect(() => createPlaylist("Too long", items(MAX_PLAYLIST_ITEMS + 1))).toThrow(
      PlaylistFullError,
    );
    const { created } = createPlaylist("Nearly full", items(MAX_PLAYLIST_ITEMS - 2));
    let refusal: unknown;
    try {
      appendToPlaylist(created.id, items(5, 1000));
    } catch (e) {
      refusal = e;
    }
    expect(playlistFullSentence(refusal)).toBe(playlistTooLong(MAX_PLAYLIST_ITEMS + 3));
    // nothing was added, and nothing was cut
    expect(getPlaylists().find((p) => p.id === created.id)?.items).toHaveLength(
      MAX_PLAYLIST_ITEMS - 2,
    );
    deletePlaylist(created.id);
  });

  it("refuses the playlist past the collection's bound and keeps every one there is", () => {
    for (let i = getPlaylists().length; i < MAX_PLAYLISTS; i++)
      createPlaylist(`List ${i}`, items(1));
    const before = getPlaylists().map((p) => p.id);
    let refusal: unknown;
    try {
      createPlaylist("One too many", items(1));
    } catch (e) {
      refusal = e;
    }
    expect(playlistFullSentence(refusal)).toBe(PLAYLISTS_FULL);
    expect(getPlaylists().map((p) => p.id)).toEqual(before);
    expect(onDisk()).toHaveLength(MAX_PLAYLISTS);
  });
});

describe("a later version's playlists, saved through the app", () => {
  it("writes back the fields it doesn't know, an item and a playlist it doesn't read, through a change", async () => {
    // the module fresh, so the store reads the file written here
    vi.resetModules();
    const electron = await import("electron");
    const file = join(electron.app.getPath("userData"), "playlists.json");
    const known = { ...item(1), fromLater: { mood: "calm" } };
    const laterItem = { station: "Radio Later", streamUrl: "http://radio.example/later" };
    const mix = {
      id: "p-mix",
      name: "Mix",
      createdAt: 1000,
      updatedAt: 2000,
      lastPlayedAt: null,
      items: [known, laterItem, item(2)],
      folder: "Evenings",
    };
    const laterList = { kind: "smart", rule: "decade:1980" };
    writeFileSync(file, JSON.stringify([mix, laterList]));
    const playlists = await import("./playlists");
    expect(playlists.getPlaylists()).toEqual([{ ...mix, items: [known, item(2)] }]);

    playlists.renamePlaylist("p-mix", "Evening mix");
    const [saved, carried] = JSON.parse(readFileSync(file, "utf-8")) as [
      Record<string, unknown>,
      unknown,
    ];
    expect(saved).toMatchObject({ name: "Evening mix", folder: "Evenings" });
    expect(saved.items).toEqual([known, laterItem, item(2)]);
    expect(carried).toEqual(laterList);
  });
});
