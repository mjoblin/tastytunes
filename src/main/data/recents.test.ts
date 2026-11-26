import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { RecentTrack } from "@shared/model";
import { getRecents, recordRecent } from "./recents";

const row = (at: number, title: string, more: Partial<RecentTrack> = {}): RecentTrack => ({
  at,
  title,
  artist: "Glass Orchard",
  album: "Paper Moons",
  station: null,
  artUrl: null,
  source: "Media Library",
  sourceId: "MEDIA_PLAYER",
  queueId: 7,
  isRadio: false,
  radioId: null,
  session: null,
  ...more,
});
const path = (): string => join(app.getPath("userData"), "recents.json");

describe("the recently played list keeps every field a row carries", () => {
  it("keeps the streamer and a field this version doesn't name, through the load and a merge", () => {
    writeFileSync(
      path(),
      JSON.stringify([
        { ...row(2000, "Tin Weather", { streamer: "evo-1" }), fromLater: 1 },
        // an old row without the fields added since, upgraded on load
        { at: 1000, title: "Lantern Hours", isRadio: false },
        // no time: left out, the file kept as found first
        { title: "No time" },
      ]),
    );
    const list = getRecents();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ streamer: "evo-1", fromLater: 1 });
    expect(list[1]).toMatchObject({ title: "Lantern Hours", session: null, queueId: null });
    // the same track again, a partial frame without the streamer: merged, the streamer kept
    recordRecent(row(3000, "Tin Weather", { artUrl: "http://nas/a.jpg" }));
    const saved = JSON.parse(readFileSync(path(), "utf-8")) as RecentTrack[];
    expect(saved[0]).toMatchObject({ streamer: "evo-1", artUrl: "http://nas/a.jpg", at: 2000 });
  });
});

/** The module fresh, so the list is read from the file written next, and that file's path. */
async function fresh() {
  vi.resetModules();
  const electron = await import("electron");
  const file = join(electron.app.getPath("userData"), "recents.json");
  return { recents: await import("./recents"), file };
}

describe("a Recent list a later version wrapped is read, and written back wrapped", () => {
  it("reads the rows inside the object and writes them back inside it, the object's fields kept", async () => {
    const { recents, file } = await fresh();
    writeFileSync(
      file,
      JSON.stringify({ format: 2, cleared: 500, items: [row(2000, "Tin Weather")] }),
    );
    expect(recents.getRecents().map((e) => e.title)).toEqual(["Tin Weather"]);
    recents.recordRecent(row(3000, "Lantern Hours"));
    const saved = JSON.parse(readFileSync(file, "utf-8")) as {
      format: number;
      cleared: number;
      items: RecentTrack[];
    };
    expect(saved.format).toBe(2);
    expect(saved.cleared).toBe(500);
    expect(saved.items.map((e) => e.title)).toEqual(["Lantern Hours", "Tin Weather"]);
    // and cleared, the object stays around an empty list
    recents.clearRecents();
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ format: 2, cleared: 500, items: [] });
  });

  it("writes a bare list back bare", async () => {
    const { recents, file } = await fresh();
    writeFileSync(file, JSON.stringify([row(2000, "Tin Weather")]));
    recents.recordRecent(row(3000, "Lantern Hours"));
    const saved = JSON.parse(readFileSync(file, "utf-8")) as RecentTrack[];
    expect(Array.isArray(saved)).toBe(true);
    expect(saved.map((e) => e.title)).toEqual(["Lantern Hours", "Tin Weather"]);
  });
});
