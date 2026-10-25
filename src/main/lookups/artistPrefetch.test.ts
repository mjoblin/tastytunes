import { describe, expect, it } from "vitest";
import { mostPlayedArtists } from "./artistPrefetch";

const play = (artist: unknown, kind = "play"): { kind: string; artist?: unknown } => ({
  kind,
  artist,
});

describe("the artists fetched ahead", () => {
  it("are the most-played by library plays, most first, as many as asked", () => {
    const events = [
      ...Array.from({ length: 3 }, () => play("The Cure")),
      ...Array.from({ length: 5 }, () => play("Low")),
      play("Slowdive"),
      // a radio session and a play with no artist count for nobody
      play("Radio Artist", "radio-session"),
      play("Radio Artist", "radio-session"),
      play(null),
      play("  "),
    ];
    expect(mostPlayedArtists(events, 2)).toEqual(["Low", "The Cure"]);
    expect(mostPlayedArtists(events)).toEqual(["Low", "The Cure", "Slowdive"]);
  });

  it("count every spelling of a name as one artist, named as it is spelled most", () => {
    const events = [play("the cure"), play("The Cure"), play("The Cure"), play("Low")];
    expect(mostPlayedArtists(events)).toEqual(["The Cure", "Low"]);
  });
});
