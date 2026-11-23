import type { PlayKind, ZonePlayStateState } from "@shared/smoip";

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
 * - WHAT IS CLAIMED is a positive list: a play from the streamer's queue, radio, or something
 *   started here (a preset recalled from the app, a link or an agent). Another app's play
 *   (AirPlay, cast, Spotify Connect, a TIDAL app) is claimed only when the setting says so, and an
 *   unknown play (no title yet, an input with no metadata) never is; while already claimed, an
 *   unknown moment keeps the claim, so a title that lags at a track change doesn't let go.
 */

export type NowPlayingVerdict = "claim" | "hold" | "release-now" | "release-soon";

/** How long a stopped streamer keeps the claim before letting go. */
export const SETTLE_MS = 3_000;

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
  state: ZonePlayStateState | null;
  kind: PlayKind | null;
  startedHere: boolean;
  claimExternal: boolean;
  claimed: boolean;
}

export function nowPlayingVerdict(i: ClaimInputs): NowPlayingVerdict {
  if (!i.connected || !i.powerOn) return "release-now";
  if (i.state == null || !LIVE.has(i.state)) return "release-soon";
  if (i.kind == null) return i.startedHere ? "claim" : i.claimed ? "hold" : "release-now";
  const ours =
    i.kind === "queue" ||
    i.kind === "radio" ||
    i.startedHere ||
    (i.kind === "external" && i.claimExternal);
  return ours ? "claim" : "release-now";
}

/**
 * STARTED HERE: a preset recalled from the app (the window, a link or an agent) makes the next
 * source to play TastyTunes' own, whatever its kind (a TIDAL or Qobuz preset reads as another
 * app's play), until the streamer moves to another source. A recall that never starts anything is
 * forgotten after PENDING_MS.
 */
export const PENDING_MS = 30_000;

export class StartedHere {
  private pendingAt: number | null = null;
  private source: string | null = null;

  recalled(now: number): void {
    this.pendingAt = now;
    this.source = null;
  }

  /** Whether the play on `sourceId` was started here, given whether the streamer is live. */
  observe(sourceId: string | null, live: boolean, now: number): boolean {
    if (this.pendingAt != null) {
      if (now - this.pendingAt > PENDING_MS) this.pendingAt = null;
      else if (live && sourceId != null) {
        this.source = sourceId;
        this.pendingAt = null;
      }
    }
    if (this.source != null && sourceId != null && sourceId !== this.source) this.source = null;
    return this.pendingAt != null || (this.source != null && sourceId === this.source);
  }
}
