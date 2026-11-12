import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/model";
import { NULLABLE_KEYS, checkFavorites, checkPlaylists, checkSettingsKinds } from "./savedChecks";

const album = {
  kind: "album",
  addedAt: 1,
  title: "Amber Nights",
  artist: "The Mock Artists",
  album: null,
  artUrl: null,
  serverUdn: "uuid:server",
  serverName: "Server",
  objectId: "alb-1",
  titlePath: ["Music", "Amber Nights"],
  aFieldFromLater: { kept: true },
};
const station = {
  kind: "station",
  addedAt: 2,
  name: "Mock FM",
  url: "http://radio.example/stream",
  favicon: null,
  radioBrowserUuid: null,
};

describe("checkFavorites", () => {
  it("passes a good file exactly as it came, a field it doesn't know included", () => {
    const notes: string[] = [];
    const rows = checkFavorites([album, station], notes);
    expect(rows).toEqual([album, station]);
    expect(rows[0]).toBe(album);
    expect(notes).toEqual([]);
  });

  it("leaves out a row without what it can't do without, and names it", () => {
    const notes: string[] = [];
    const rows = checkFavorites(
      [album, { ...album, title: 7 }, null, { ...station, url: undefined }, { kind: "song" }],
      notes,
    );
    expect(rows).toEqual([album]);
    expect(notes).toEqual([
      "[1].title was a number, so the row was left out",
      "[2] was null, left out",
      "[3] had no url, left out",
      '[4].kind was "song", left out',
    ]);
  });

  it("sets aside a field of the wrong kind, keeping the row", () => {
    const notes: string[] = [];
    const [row] = checkFavorites([{ ...album, artist: 5, copy: 3, titlePath: ["a", 2] }], notes);
    expect(row).toMatchObject({ title: "Amber Nights", artist: null, titlePath: ["a"] });
    expect("copy" in row).toBe(false);
    expect(notes).toEqual([
      "[0].artist was a number, set aside",
      "[0].titlePath held 1 of the wrong kind, left out",
      "[0].copy was a number, set aside",
    ]);
  });

  it("reads anything but a list as no rows, and names it; a missing file says nothing", () => {
    const notes: string[] = [];
    expect(checkFavorites({ items: [album] }, notes)).toEqual([]);
    expect(notes).toEqual(["it held an object, not a list"]);
    const none: string[] = [];
    expect(checkFavorites(undefined, none)).toEqual([]);
    expect(none).toEqual([]);
  });
});

describe("checkPlaylists", () => {
  const item = {
    title: "Low Tide",
    artist: null,
    album: null,
    artUrl: null,
    serverUdn: null,
    serverName: null,
    objectId: "t1",
  };
  const list = { id: "p1", name: "Evening", createdAt: 1, updatedAt: 2, items: [item] };

  it("passes a good playlist as it came", () => {
    const notes: string[] = [];
    const [kept] = checkPlaylists([list], notes);
    expect(kept).toBe(list);
    expect(notes).toEqual([]);
  });

  it("leaves out a bad item, keeping the playlist, and a playlist without its id", () => {
    const notes: string[] = [];
    const rows = checkPlaylists(
      [
        { ...list, items: [item, { artist: "no title" }, "x"] },
        { ...list, id: 3 },
      ],
      notes,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].items).toEqual([item]);
    expect(notes).toEqual([
      "[0].items[1] had no title, left out",
      "[0].items[2] was a string, left out",
      "[1].id was a number, so the row was left out",
    ]);
  });
});

describe("checkSettingsKinds", () => {
  it("leaves out a value of the wrong kind so its default stands, keeping keys it doesn't know", () => {
    const notes: string[] = [];
    const out = checkSettingsKinds(
      {
        theme: 3,
        tray: "yes",
        lastHost: null,
        volumeLimitPercent: 40,
        navHidden: "x",
        fromLater: 1,
      },
      notes,
    );
    expect(out).toEqual({ lastHost: null, volumeLimitPercent: 40, fromLater: 1 });
    // in the defaults' own order
    expect(notes).toEqual([
      "tray was a string, so its default stands",
      "theme was a number, so its default stands",
      "navHidden was a string, so its default stands",
    ]);
  });

  it("holds null to the settings whose default is null, and the mcp object's own values", () => {
    const notes: string[] = [];
    const out = checkSettingsKinds(
      { theme: null, lastHost: 5, mcp: { port: "8555", enabled: true, token: "kept" } },
      notes,
    );
    expect(out).toEqual({ mcp: { enabled: true, token: "kept" } });
    expect(notes).toEqual([
      "lastHost was a number, so its default stands",
      "theme was null, so its default stands",
      "mcp.port was a string, so its default stands",
    ]);
  });

  it("names a kind for every setting whose default is null", () => {
    const nullDefaults = Object.entries(DEFAULT_SETTINGS)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    expect(nullDefaults.every((k) => NULLABLE_KEYS.includes(k))).toBe(true);
  });

  it("passes the defaults themselves untouched", () => {
    const notes: string[] = [];
    const defaults = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Record<string, unknown>;
    expect(checkSettingsKinds(defaults, notes)).toEqual(defaults);
    expect(notes).toEqual([]);
  });
});
