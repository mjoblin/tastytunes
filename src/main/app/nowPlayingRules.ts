import {
  isCdPlayback,
  playKindOf,
  type PlayKind,
  type ZoneNowPlaying,
  type ZonePlayState,
  type ZonePlayStateState,
} from "@shared/smoip";
import { recallSignature } from "../device/recallWatch";

/**
 * WHEN TASTYTUNES IS THE SYSTEM'S PLAYING APP (0.17.0, the media keys through macOS's Now Playing):
 * pure rules, unit-tested; main/app/nowPlaying applies them. Claiming takes the media keys, Control
 * Center's buttons and a headset's button from whatever app had them; letting go hands them back.
 *
 * - Standby or a lost connection lets go at once: TastyTunes holds the keys only while the streamer
 *   is playing or paused, so with the streamer asleep the keys are the Mac's again.
 * - Stop, not_ready and no_signal let go after a short settle; buffering, connecting and ready
 *   count as live, so a track change passing through them never lets go and claims again (a
 *   fresh claim would take the keys back from whatever the owner had turned to).
 * - WHAT IS CLAIMED is a positive list: a play from the streamer's queue, a disc, radio, or
 *   something started here (a preset recalled from the app, a link or an agent). Another app's play
 *   (AirPlay, cast, Spotify Connect, a TIDAL app) is claimed only when the setting says so, and an
 *   unknown play (no title yet, an input with no metadata) never is.
 * - NEVER THE BUILT-IN DEMO: it plays nothing, so claiming it would take the keys from the app the
 *   person is listening to for a silent simulation (the Windows smoke's override aside).
 * - NEVER A PLAY THE KEYS CAN'T STEER: a play that offers no play, pause, next or previous (an
 *   input such as AirPlay waiting, the TV, analog) is never claimed, even started here: claiming
 *   it would take the keys from another app and give nothing back.
 * - A HELD CLAIM IS SHORT: while claimed, a moment with no title or no controls (a track change's
 *   lag) keeps the claim, but only on the source it was claimed on and for HOLD_MS; a move to
 *   another source, or a lag that outlasts it, lets go.
 */

export type NowPlayingVerdict = "claim" | "hold" | "release-now" | "release-soon";

/** How long a stopped streamer keeps the claim before letting go. */
export const SETTLE_MS = 3_000;

/** How long a claim is held through a moment with no title or no controls. */
export const HOLD_MS = 10_000;

const LIVE: ReadonlySet<ZonePlayStateState> = new Set([
  "play",
  "pause",
  "buffering",
  "connecting",
  "ready",
]);

export interface ClaimInputs {
  connected: boolean;
  powerOn: boolean;
  /** Connected to the built-in demo streamer, which is never claimed. */
  demo: boolean;
  state: ZonePlayStateState | null;
  kind: PlayKind | null;
  startedHere: boolean;
  claimExternal: boolean;
  claimed: boolean;
  /** Whether the play offers the keys anything: play or pause, next or previous. */
  steerable: boolean;
  /** The streamer's source now, and the one the claim was made on. */
  source: string | null;
  claimedSource: string | null;
  /** How long the claim has been held through a moment with no title or controls (0 if not). */
  heldMs: number;
}

export function nowPlayingVerdict(i: ClaimInputs): NowPlayingVerdict {
  if (!i.connected || !i.powerOn || i.demo) return "release-now";
  if (i.state == null || !LIVE.has(i.state)) return "release-soon";
  const holdable =
    i.claimed && i.source != null && i.source === i.claimedSource && i.heldMs < HOLD_MS;
  if (i.kind == null || !i.steerable) return holdable ? "hold" : "release-now";
  const ours =
    i.kind === "queue" ||
    i.kind === "radio" ||
    i.startedHere ||
    (i.kind === "external" && i.claimExternal);
  return ours ? "claim" : "release-now";
}

/**
 * What a play is, for the claim: playKindOf's, except that a disc is the streamer's own play,
 * claimed like its queue's. A disc has no queue_id, so playKindOf files it as another app's, or as
 * nothing while play_state's title is the disc's table of contents; the listening record keeps
 * playKindOf's filing.
 */
export function claimKind(ps: ZonePlayState | null, np: ZoneNowPlaying | null): PlayKind | null {
  return isCdPlayback(ps?.metadata, np?.display) ? "queue" : playKindOf(ps);
}

/**
 * STARTED HERE: a preset recalled from the app (the window, a link, an agent, a schedule) makes
 * the play it starts TastyTunes' own, whatever its kind (a TIDAL or Qobuz preset reads as another
 * app's play), until the streamer moves to another source.
 *
 * - THE PLAY IT STARTS, NEVER THE ONE THERE AS IT WENT OUT: each recall notes what plays as it is
 *   sent (device/recallWatch's recallSignature: the source, the station, the queue entry and its
 *   title), and its play is the first after it that differs. An album paused or a phone's AirPlay
 *   is never taken for it: the streamer moves to the preset's source after the recall, so a claim
 *   latched on the old play would drop there and leave the preset's play unclaimed.
 * - ONLY A PLAY WITH A NAME, AND NOT A PAUSE: a recall's first moment names nothing (and may still
 *   carry the old source), and its play starts playing; a pause is what the streamer held through
 *   standby, re-announced by the wake.
 * - Every recall notes again, the same preset's included, and a play latched by an earlier recall
 *   keeps its claim until the source moves. A recall after which nothing new plays is forgotten
 *   after PENDING_MS, so one that came to nothing claims nothing: it goes out after any wake, and
 *   one that changes nothing in 8 s has come to nothing (device/recallWatch's DEAD_RECALL_MS).
 */
export const PENDING_MS = 20_000;

export class StartedHere {
  /** What played as the last recall went out, while the play it starts is awaited. */
  private pending: { before: string; at: number } | null = null;
  private source: string | null = null;

  /** A recall went out while `ps` played. */
  recalled(ps: ZonePlayState | null, now: number): void {
    this.pending = { before: recallSignature(ps), at: now };
  }

  /** The app connected to a streamer, or let one go: nothing started on the last one is this one's. */
  forget(): void {
    this.pending = null;
    this.source = null;
  }

  /** Whether the play `ps` was started here, given whether the streamer is live. */
  observe(ps: ZonePlayState | null, live: boolean, now: number): boolean {
    const source = ps?.metadata?.source ?? null;
    const p = this.pending;
    if (p != null && now - p.at > PENDING_MS) this.pending = null;
    else if (
      p != null &&
      live &&
      source != null &&
      ps?.state !== "pause" &&
      playKindOf(ps) != null &&
      recallSignature(ps) !== p.before
    ) {
      this.source = source;
      this.pending = null;
    }
    if (this.source != null && source != null && source !== this.source) this.source = null;
    return this.source != null && source === this.source;
  }
}
