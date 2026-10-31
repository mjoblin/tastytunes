import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { beforeAll, describe, expect, it } from "vitest";
import type { RecentTrack } from "@shared/model";
import { decorateRecents } from "./recentArt";

// a dead streamer address: the capture is the only picture these plays have
const DEAD = "http://127.0.0.1:9/album-art-dead?id=1:0";
const play = (title: string, album: string, sourceId: string): RecentTrack => ({
  at: 1,
  title,
  artist: "Mock Band",
  album,
  station: null,
  artUrl: DEAD,
  source: sourceId,
  sourceId,
  queueId: null,
  isRadio: false,
  radioId: null,
  session: `src:${sourceId}`,
  streamer: null,
});

beforeAll(() => {
  const cache = join(app.getPath("userData"), "cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(
    join(cache, "recentart.json"),
    JSON.stringify({
      version: 1,
      entries: [
        ["first song|mock band|mock record", { v: "data:image/jpeg;base64,QUxCVU0=", at: 1 }],
      ],
    }),
  );
});

describe("decorateRecents: a track's cover is its album's", () => {
  it("shows a play the capture missed its album's captured cover, while another album's play and a library play keep their own", () => {
    const [missed, other, library] = decorateRecents([
      play("Second Song", "Mock Record", "AIRPLAY"),
      play("Other Song", "Other Record", "AIRPLAY"),
      play("Second Song", "Mock Record", "MEDIA_PLAYER"),
    ]);
    expect(missed.artUrl?.slice(0, 22)).toBe("data:image/jpeg;base64");
    expect(other.artUrl?.startsWith("http://127.0.0.1:9/")).toBe(true);
    expect(library.artUrl?.startsWith("http://127.0.0.1:9/")).toBe(true);
  });
});
