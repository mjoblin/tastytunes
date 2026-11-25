import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { describe, expect, it } from "vitest";
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
