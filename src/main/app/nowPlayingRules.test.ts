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
  heldStation: false,
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

describe("a station toggled to stop", () => {
  const station = { kind: "radio" as const, source: "IR", claimed: true, claimedSource: "IR" };
  it("keeps its claim while it is the station claimed and can be started again", () => {
    expect(v({ ...station, state: "stop" })).toBe("claim");
  });

  it("lets go when it wasn't claimed, can't be started, or another source took over", () => {
    expect(v({ ...station, state: "stop", claimed: false, claimedSource: null })).toBe(
      "release-soon",
    );
    expect(v({ ...station, state: "stop", steerable: false })).toBe("release-soon");
    expect(v({ ...station, state: "stop", source: "AIRPLAY" })).toBe("release-soon");
  });

  it("is claimed again after a reconnect when it is the station held, still stopped", () => {
    const after = { kind: "radio" as const, source: "IR", claimed: false, claimedSource: null };
    expect(v({ ...after, state: "stop", heldStation: true })).toBe("claim");
    expect(v({ ...after, state: "stop", heldStation: false })).toBe("release-soon");
    expect(v({ ...after, state: "stop", heldStation: true, steerable: false })).toBe(
      "release-soon",
    );
  });

  it("is a station's alone: a stopped queue or disc still lets go", () => {
    expect(v({ ...held, state: "stop" })).toBe("release-soon");
  });

  it("lets go at standby and on a disconnect", () => {
    expect(v({ ...station, state: "stop", powerOn: false })).toBe("release-now");
    expect(v({ ...station, state: "stop", connected: false })).toBe("release-now");
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
  const track = (
    source: string,
    title: string | null,
    state = "play",
    queueId: number | null = null,
  ): ZonePlayState =>
    ({
      state,
      queue_id: queueId,
      metadata: { class: "md.track", source, title },
    }) as unknown as ZonePlayState;
  const album = (state = "play") => track("MEDIA_PLAYER", "Side One", state, 7);
  const tidal = (title = "Mix Track") => track("TIDAL", title);
  const airplay = (title = "Phone Song") => track("AIRPLAY", title);

  it("is the play a recall starts, never the one playing as it went, until the source moves", () => {
    const s = new StartedHere();
    expect(s.observe(album("pause"), true, 0)).toBe(false);
    s.recalled(album("pause"), 1_000);
    // the album still paused, then the recall's first moment, which names nothing
    expect(s.observe(album("pause"), true, 1_050)).toBe(false);
    expect(s.observe(album(), true, 1_080)).toBe(false);
    expect(s.observe(track("MEDIA_PLAYER", null, "connecting"), true, 1_100)).toBe(false);
    expect(s.observe(tidal(), true, 2_000)).toBe(true);
    expect(s.observe(tidal("Next Track"), true, 60_000)).toBe(true);
    expect(s.observe(airplay(), true, 61_000)).toBe(false);
    expect(s.observe(tidal(), true, 62_000)).toBe(false);
  });

  it("is a new title on the same source, whatever source the preset's play reports", () => {
    const s = new StartedHere();
    s.recalled(album("pause"), 0);
    expect(s.observe(track("MEDIA_PLAYER", "Mix Track"), true, 1_000)).toBe(true);
    const q = new StartedHere();
    q.recalled(album(), 0);
    expect(q.observe(track("MEDIA_PLAYER", "Mix Track", "play", 40), true, 1_000)).toBe(true);
  });

  it("is never a phone's AirPlay playing as the recall went, only the recall's own play", () => {
    const s = new StartedHere();
    s.recalled(airplay(), 0);
    expect(s.observe(airplay(), true, 500)).toBe(false);
    expect(s.observe(tidal(), true, 2_000)).toBe(true);
  });

  it("is never a pause, which is what a wake re-announces, but the recall's play after it", () => {
    const s = new StartedHere();
    s.recalled(track("MEDIA_PLAYER", null, "not_ready"), 0);
    expect(s.observe(track("MEDIA_PLAYER", null, "stop", 7), false, 100)).toBe(false);
    expect(s.observe(album("pause"), true, 160)).toBe(false);
    expect(s.observe(tidal(), true, 3_000)).toBe(true);
  });

  it("is forgotten when the app connects to a streamer or lets one go", () => {
    const s = new StartedHere();
    s.recalled(album(), 0);
    expect(s.observe(tidal(), true, 1_000)).toBe(true);
    s.forget();
    expect(s.observe(tidal(), true, 2_000)).toBe(false);
    const q = new StartedHere();
    q.recalled(album(), 0);
    q.forget();
    expect(q.observe(tidal(), true, 1_000)).toBe(false);
  });

  it("is noted again on every recall, the same preset's included", () => {
    const s = new StartedHere();
    s.recalled(album(), 0);
    expect(s.observe(tidal(), true, 1_000)).toBe(true);
    expect(s.observe(airplay(), true, 30_000)).toBe(false);
    s.recalled(airplay(), 40_000);
    expect(s.observe(airplay(), true, 40_100)).toBe(false);
    expect(s.observe(tidal(), true, 41_000)).toBe(true);
  });

  it("keeps a play an earlier recall started while a later one changes nothing", () => {
    const s = new StartedHere();
    s.recalled(album(), 0);
    expect(s.observe(tidal(), true, 1_000)).toBe(true);
    s.recalled(tidal(), 5_000);
    expect(s.observe(tidal(), true, 5_100)).toBe(true);
    expect(s.observe(tidal(), true, 5_000 + PENDING_MS + 1)).toBe(true);
  });

  it("is forgotten when a recall starts nothing, so a later play isn't taken for it", () => {
    const s = new StartedHere();
    s.recalled(airplay(), 0);
    expect(s.observe(airplay(), true, PENDING_MS)).toBe(false);
    expect(s.observe(airplay("Another Phone Song"), true, PENDING_MS + 1)).toBe(false);
    expect(s.observe(tidal(), true, PENDING_MS + 2)).toBe(false);
  });
});
