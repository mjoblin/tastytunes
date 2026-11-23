import { describe, expect, it } from "vitest";
import {
  HOLD_MS,
  nowPlayingVerdict,
  PENDING_MS,
  StartedHere,
  type ClaimInputs,
} from "./nowPlayingRules";

const base: ClaimInputs = {
  connected: true,
  powerOn: true,
  state: "play",
  kind: "queue",
  startedHere: false,
  claimExternal: false,
  claimed: false,
  steerable: true,
  source: "MEDIA_PLAYER",
  claimedSource: null,
  heldMs: 0,
};
const held = { claimed: true, claimedSource: "MEDIA_PLAYER" };
const v = (over: Partial<ClaimInputs>) => nowPlayingVerdict({ ...base, ...over });

describe("when TastyTunes claims the system's Now Playing", () => {
  it("claims a queue play and radio, playing or paused, and through a track change's states", () => {
    for (const state of ["play", "pause", "buffering", "connecting", "ready"] as const) {
      expect(v({ state })).toBe("claim");
      expect(v({ state, kind: "radio" })).toBe("claim");
    }
  });

  it("lets go at once on standby or a lost connection, and after a settle when stopped", () => {
    expect(v({ powerOn: false })).toBe("release-now");
    expect(v({ connected: false })).toBe("release-now");
    for (const state of ["stop", "not_ready", "no_signal", null] as const)
      expect(v({ state })).toBe("release-soon");
  });

  it("leaves another app's play alone unless the setting says so, or the app started it", () => {
    expect(v({ kind: "external" })).toBe("release-now");
    expect(v({ kind: "external", claimExternal: true })).toBe("claim");
    expect(v({ kind: "external", startedHere: true })).toBe("claim");
  });

  it("never claims an unknown play, but an unknown moment keeps a claim already held", () => {
    expect(v({ kind: null })).toBe("release-now");
    expect(v({ kind: null, claimExternal: true })).toBe("release-now");
    expect(v({ kind: null, startedHere: true })).toBe("release-now");
    expect(v({ kind: null, ...held })).toBe("hold");
  });

  it("holds a claim only on the source it was claimed on, and only for a while", () => {
    expect(v({ kind: null, ...held, heldMs: HOLD_MS - 1 })).toBe("hold");
    expect(v({ kind: null, ...held, heldMs: HOLD_MS })).toBe("release-now");
    // a queue play claimed, then the streamer moves to an input with nothing to show
    expect(v({ kind: null, ...held, source: "AIRPLAY" })).toBe("release-now");
    expect(v({ kind: null, ...held, source: null })).toBe("release-now");
  });

  it("never claims a play the keys can do nothing with, even one started here", () => {
    expect(v({ steerable: false })).toBe("release-now");
    expect(v({ kind: "external", startedHere: true, steerable: false })).toBe("release-now");
    expect(v({ kind: "radio", steerable: false })).toBe("release-now");
    // a claimed play whose controls drop for a moment keeps the claim, as a lagging title does
    expect(v({ steerable: false, ...held })).toBe("hold");
    expect(v({ steerable: false, ...held, heldMs: HOLD_MS })).toBe("release-now");
  });
});

describe("a play started here", () => {
  it("is the next source to play after a recall, until the streamer moves to another", () => {
    const s = new StartedHere();
    expect(s.observe("TIDAL", true, 0)).toBe(false);
    s.recalled(1_000);
    expect(s.observe("TIDAL", false, 1_100)).toBe(true);
    expect(s.observe("TIDAL", true, 2_000)).toBe(true);
    expect(s.observe("TIDAL", true, 60_000)).toBe(true);
    expect(s.observe("AIRPLAY", true, 61_000)).toBe(false);
    expect(s.observe("TIDAL", true, 62_000)).toBe(false);
  });

  it("is forgotten when a recall starts nothing", () => {
    const s = new StartedHere();
    s.recalled(0);
    expect(s.observe(null, false, PENDING_MS + 1)).toBe(false);
  });
});
