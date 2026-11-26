import { describe, expect, it } from "vitest";
import { playKindOf, type ZoneNowPlaying, type ZonePlayState } from "@shared/smoip";
import {
  claimKind,
  HOLD_MS,
  nowPlayingVerdict,
  PENDING_MS,
  StartedHere,
  type ClaimInputs,
} from "./nowPlayingRules";

const base: ClaimInputs = {
  connected: true,
  powerOn: true,
  demo: false,
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

  it("never claims the built-in demo, and lets go of it at once", () => {
    expect(v({ demo: true })).toBe("release-now");
    expect(v({ demo: true, kind: "external", startedHere: true })).toBe("release-now");
    expect(v({ demo: true, ...held })).toBe("release-now");
  });
});

describe("what a play is, for the claim", () => {
  const disc = (title: string, display: string | null = null) => ({
    ps: {
      state: "play",
      queue_id: null,
      metadata: { class: "md.track.cd", source: "CD", title },
    } as unknown as ZonePlayState,
    np: { display: { class: display } } as unknown as ZoneNowPlaying,
  });

  it("is the streamer's own for a disc, whatever its title, while the listening record's filing stays", () => {
    const toc = disc("Tracks: 10 Length: 37:39");
    expect(claimKind(toc.ps, toc.np)).toBe("queue");
    expect(playKindOf(toc.ps)).toBeNull();
    const track = disc("Side One");
    expect(claimKind(track.ps, track.np)).toBe("queue");
    expect(playKindOf(track.ps)).toBe("external");
    // a disc known only by now_playing's display class
    const shown = {
      ps: { state: "play", queue_id: null, metadata: { source: "CD", title: "Side One" } },
      np: { display: { class: "digital.cd" } },
    } as unknown as { ps: ZonePlayState; np: ZoneNowPlaying };
    expect(claimKind(shown.ps, shown.np)).toBe("queue");
  });

  it("is playKindOf's for anything else", () => {
    const airplay = {
      state: "play",
      queue_id: null,
      metadata: { class: "md.track", source: "AIRPLAY", title: "Song" },
    } as unknown as ZonePlayState;
    expect(claimKind(airplay, null)).toBe("external");
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
