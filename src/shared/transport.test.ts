import { describe, expect, it } from "vitest";
import { commandForMedia, transportAbilities } from "./transport";

const all = transportAbilities(
  ["play_pause", "track_previous", "track_next", "seek", "stop", "toggle_shuffle", "toggle_repeat"],
  240,
);

describe("the transport's abilities", () => {
  it("come from the source's controls list, seeking only with a length", () => {
    expect(all).toEqual({
      canToggle: true,
      canPrev: true,
      canNext: true,
      canSeek: true,
      canShuffle: true,
      canRepeat: true,
      canStop: true,
    });
    expect(transportAbilities(["seek"], null).canSeek).toBe(false);
    expect(transportAbilities(null)).toMatchObject({ canToggle: false, canNext: false });
  });
});

describe("a media command", () => {
  it("plays and pauses through the play button's toggle, and does nothing when already so", () => {
    expect(commandForMedia("play", "pause", all)).toEqual({ type: "togglePlayback" });
    expect(commandForMedia("play", "stop", all)).toEqual({ type: "togglePlayback" });
    expect(commandForMedia("play", "play", all)).toBeNull();
    expect(commandForMedia("pause", "play", all)).toEqual({ type: "togglePlayback" });
    expect(commandForMedia("pause", "pause", all)).toBeNull();
    expect(commandForMedia("toggle", "play", all)).toEqual({ type: "togglePlayback" });
  });

  it("skips, stops and seeks only where the source can", () => {
    const radio = transportAbilities(["play_pause", "stop"], null);
    expect(commandForMedia("next", "play", radio)).toBeNull();
    expect(commandForMedia("previous", "play", radio)).toBeNull();
    expect(commandForMedia("seek", "play", radio, 30)).toBeNull();
    expect(commandForMedia("stop", "play", radio)).toEqual({ type: "stop" });
    expect(commandForMedia("next", "play", all)).toEqual({ type: "nextTrack" });
    expect(commandForMedia("seek", "play", all, 61.6)).toEqual({ type: "seek", positionSecs: 62 });
  });
});
