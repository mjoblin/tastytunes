import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { describe, expect, it } from "vitest";
import { favoriteKey, type Favorite } from "@shared/model";
import { addFavorite, getFavorites, removeFavorite, updateFavorite } from "./favorites";

const path = (): string => join(app.getPath("userData"), "favorites.json");
const onDisk = (): unknown => JSON.parse(readFileSync(path(), "utf-8")) as unknown;

const album = {
  kind: "album",
  addedAt: 3000,
  title: "Amber Nights",
  artist: "The Mock Artists",
  album: null,
  artUrl: null,
  serverUdn: "uuid:server",
  serverName: "Server",
  objectId: "alb-1",
  titlePath: ["Music", "Amber Nights"],
  // a field this version doesn't know, as a later version might write it
  aFieldFromLater: { kept: true },
};
// a kind of favorite this version doesn't read: kept out of the app, written back at its place
const laterKind = { kind: "playlist", addedAt: 2000, name: "Later", playlistId: "p-9" };
const station = {
  kind: "station",
  addedAt: 1000,
  name: "Mock FM",
  url: "http://radio.example/stream",
  favicon: null,
  radioBrowserUuid: null,
};

// one file, read once: the test writes it before the store's first read
describe("a later version's favorites, saved through the app", () => {
  it("writes back a field it doesn't know and a row it doesn't read, through each change", () => {
    writeFileSync(path(), JSON.stringify([album, laterKind, station]));
    expect(getFavorites()).toEqual([album, station]);

    // a change to the row with the field it doesn't know
    updateFavorite(favoriteKey(album as Favorite), { objectId: "alb-2" });
    expect(onDisk()).toEqual([{ ...album, objectId: "alb-2" }, laterKind, station]);

    // a new favorite, newest first, the carried row back at its place in the file
    const track: Favorite = {
      kind: "track",
      addedAt: 4000,
      title: "Tin Weather",
      artist: "Glass Orchard",
      album: "Paper Moons",
      artUrl: null,
      serverUdn: null,
      serverName: null,
      objectId: null,
      titlePath: null,
      durationSecs: 200,
    };
    addFavorite(track);
    expect(onDisk()).toEqual([track, laterKind, { ...album, objectId: "alb-2" }, station]);

    // and one removed
    removeFavorite(favoriteKey(station as Favorite));
    expect(onDisk()).toEqual([track, laterKind, { ...album, objectId: "alb-2" }]);
  });
});
