import { describe, expect, it } from "vitest";
import type { ListeningEvent } from "@shared/model";
import { cardSources, sourceNameOf, statsFor } from "./historyStats";

const at = Date.UTC(2026, 9, 9, 12);
const play = (secs: number, lossless: boolean | null): ListeningEvent => ({
  v: 1,
  kind: "play",
  at,
  tzOffsetMin: 0,
  title: "Chicago",
  artist: "The Oscar Peterson Trio",
  album: "The Trio",
  playedSeconds: secs,
  duration: 517,
  codec: "FLAC",
  sampleRate: 44100,
  bitDepth: 16,
  lossless,
  source: "Media Library",
  sourceId: "MEDIA_PLAYER",
});
const external = (secs: number, source: string, sourceId: string): ListeningEvent => ({
  v: 1,
  kind: "external",
  at,
  tzOffsetMin: 0,
  source,
  sourceId,
  title: "A Song",
  artist: "A Band",
  album: null,
  playedSeconds: secs,
  duration: null,
});

describe("sourceNameOf: where a line played", () => {
  it("names a queue play and the media player's queueless play both Library", () => {
    expect(sourceNameOf(play(60, true))).toBe("Library");
    // a user's Stats showed "Media Library" (the Evo's name for the input) under "Library"
    expect(sourceNameOf(external(60, "Media Library", "MEDIA_PLAYER"))).toBe("Library");
  });
  it("keeps every other source's own name", () => {
    expect(sourceNameOf(external(60, "Spotify", "SPOTIFY"))).toBe("Spotify");
    expect(sourceNameOf(external(60, "AirPlay", "AIRPLAY"))).toBe("AirPlay");
  });
});

describe("statsFor: the Library row and the files", () => {
  it("adds a queueless media-player track to the Library row as time and a track", () => {
    const s = statsFor([play(300, true), external(120, "Media Library", "MEDIA_PLAYER")]);
    expect(s.bySource.map((r) => r.source)).toEqual(["Library"]);
    expect(s.bySource[0]).toMatchObject({ seconds: 420, count: 2 });
  });
  it("counts only Library plays in the files, so another source's time is not lossy time", () => {
    const s = statsFor([play(300, true), play(240, false), external(3600, "Spotify", "SPOTIFY")]);
    expect(s.quality).toMatchObject({ lossless: 300, lossy: 240 });
    expect(s.bySource.find((r) => r.source === "Spotify")?.seconds).toBe(3600);
  });
});

describe("cardSources: the saved card's Where it played", () => {
  const row = (source: string, seconds: number) => ({ source, seconds, count: 1, unit: "tracks" });
  it("keeps every source when four fit", () => {
    const rows = [row("Library", 100), row("CD", 50), row("Spotify", 20), row("AirPlay", 1)];
    expect(cardSources(rows)).toEqual(rows);
  });
  it("folds the fourth on into one row past four, so the time adds up", () => {
    const rows = [
      row("Library", 100),
      row("CD", 50),
      row("Spotify", 20),
      row("AirPlay", 2),
      row("Radio", 3),
    ];
    const out = cardSources(rows);
    expect(out.map((r) => r.source)).toEqual(["Library", "CD", "Spotify", "Other sources"]);
    expect(out[3]).toMatchObject({ seconds: 5, count: 2, unit: "sources" });
    expect(out.reduce((a, r) => a + r.seconds, 0)).toBe(175);
  });
});
