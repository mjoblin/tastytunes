import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { StreamerCommand } from "@shared/ipc";
import {
  playKindOf,
  radioTrackTitle,
  trackTitle,
  type ZoneNowPlaying,
  type ZonePlayState,
} from "@shared/smoip";
import { commandForMedia, transportAbilities, type MediaCommand } from "@shared/transport";
import { HOLD_MS, nowPlayingVerdict, SETTLE_MS, StartedHere } from "./nowPlayingRules";

/**
 * THE NOW PLAYING HELPER'S OTHER END (0.17.0): starts the helper (native/nowplaying), feeds it what
 * the streamer is playing when that changes, lets go by nowPlayingRules, and turns its commands
 * into the app's own (shared/transport). Every outside dependency is passed in, so the unit tests
 * drive it with a fake helper over the same stdio; main/app/nowPlaying wires it to the app.
 *
 * - The helper must say "hello tastytunes-nowplaying 1" first, or it is stopped and not used.
 * - It is sent a message only when something a reader would see changed, never on a timer: the
 *   elapsed time and the rate let macOS run the clock, and a position that drifts or jumps (a seek)
 *   is sent again.
 * - A helper that exits on its own is started again after 1, 5 and 30 s, and given up on after
 *   five restarts in ten minutes. One that never says hello, speaks another protocol, or ends
 *   before its hello (a Windows without the media features) is given up on at once, with its
 *   last stderr line in the log. GIVING UP IS SAID (gaveUp): app/mediaKeys then binds the keys
 *   the old way, so a helper that can't run never leaves the keys dead.
 * - While a claim is held (a title that lags), the tile keeps the last info; a new sleeve is
 *   waited for a moment (ART_WAIT_MS) before a new track is shown, so the tile doesn't flash the
 *   app's icon between albums.
 */

export const PROTOCOL = 1;
const HELLO = `hello tastytunes-nowplaying ${PROTOCOL}`;
const HELLO_MS = 5_000;
const RESTARTS = [1_000, 5_000, 30_000];
const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS = 5;
/** How far the streamer's position may wander from macOS's own clock before it is sent again. */
const DRIFT_SECS = 2.5;
/** How long a new track waits for its sleeve before it is shown without one. */
export const ART_WAIT_MS = 1_500;

export interface StreamerView {
  connected: boolean;
  powerOn: boolean;
  playState: ZonePlayState | null;
  nowPlaying: ZoneNowPlaying | null;
  position: number | null;
}

export interface BridgeDeps {
  /** The helper's path and arguments (a test's fake runs under node). */
  command: { file: string; args?: string[] };
  view(): StreamerView;
  claimExternal(): boolean;
  fire(cmd: StreamerCommand): void;
  /** The Now Playing tile was clicked: the app's window forward. */
  activate(): void;
  /** The sleeve at `url` as a local file the helper can read, or null. */
  artFile(url: string): Promise<string | null>;
  /** The picture for a play with no sleeve (the app's icon), so the tile never shows a blank. */
  fallbackArt: string | null;
  log(text: string): void;
  now(): number;
  /** The helper was given up on: the keys need their old route. */
  gaveUp?(): void;
}

interface Info {
  t: "info";
  title: string;
  artist: string;
  album: string;
  duration?: number;
  elapsed?: number;
  playing: boolean;
  live: boolean;
  art?: string;
  can: { toggle: boolean; next: boolean; previous: boolean; seek: boolean; stop: boolean };
}

export class NowPlayingBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private wanted = false;
  private restarts: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private claimed = false;
  private lastShape = "";
  private lastElapsed: { secs: number; at: number; rate: number } | null = null;
  private artFor: string | null = null;
  private artPath: string | null = null;
  /** The sleeve asked for and not yet answered, waited for until `until`. */
  private artWaiting: { until: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private holdingSince: number | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private claimedSource: string | null = null;
  private givenUp = false;
  private readonly started = new StartedHere();

  constructor(private readonly deps: BridgeDeps) {}

  get running(): boolean {
    return this.child != null && this.ready;
  }

  /** Given up on (no hello, another protocol, ended before its hello, or kept exiting): not used
   *  until the setting is turned off and on. */
  get gaveUp(): boolean {
    return this.givenUp;
  }

  start(): void {
    if (this.givenUp) return;
    this.wanted = true;
    if (!this.child) this.spawn();
  }

  stop(): void {
    this.wanted = false;
    this.givenUp = false;
    this.restarts = [];
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.clearSettle();
    this.clearHold();
    this.clearArtWait();
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.claimed = false;
    if (child) {
      // the helper lets go itself when its pipe closes: it exits
      child.stdin.end();
      setTimeout(() => {
        if (child.exitCode == null) child.kill();
      }, 2_000);
    }
  }

  /** A preset was recalled from the app: the next source to play is TastyTunes' own. */
  recalled(): void {
    this.started.recalled(this.deps.now());
    this.update();
  }

  /** Something the streamer reported changed: claim, update, or let go. */
  update(): void {
    if (!this.running) return;
    const v = this.deps.view();
    const ps = v.playState;
    const state = ps?.state ?? null;
    const kind = playKindOf(ps);
    const live =
      v.connected &&
      v.powerOn &&
      state != null &&
      !["stop", "not_ready", "no_signal"].includes(state);
    const now = this.deps.now();
    const source = ps?.metadata?.source ?? null;
    const startedHere = this.started.observe(source, live, now);
    const can = transportAbilities(v.nowPlaying?.controls, ps?.metadata?.duration ?? null);
    const verdict = nowPlayingVerdict({
      connected: v.connected,
      powerOn: v.powerOn,
      state,
      kind,
      startedHere,
      claimExternal: this.deps.claimExternal(),
      claimed: this.claimed,
      steerable: can.canToggle || can.canNext || can.canPrev,
      source,
      claimedSource: this.claimedSource,
      heldMs: this.holdingSince != null ? now - this.holdingSince : 0,
    });
    if (verdict === "release-now") return this.release("now");
    if (verdict === "release-soon") {
      // stopped: let go only if it is still so after the settle (a track change passes through)
      if (this.claimed && !this.settleTimer)
        this.settleTimer = setTimeout(() => {
          this.settleTimer = null;
          const again = this.deps.view();
          const st = again.playState?.state ?? null;
          if (st == null || ["stop", "not_ready", "no_signal"].includes(st))
            this.release("stopped");
          else this.update();
        }, SETTLE_MS);
      return;
    }
    this.clearSettle();
    if (verdict === "hold") {
      // the tile keeps the last info; a hold that outlasts HOLD_MS lets go at its check
      if (this.holdingSince == null) {
        this.holdingSince = now;
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null;
          this.update();
        }, HOLD_MS);
      }
      return;
    }
    this.clearHold();
    this.claimedSource = source;
    this.publish(v);
  }

  private publish(v: StreamerView): void {
    const ps = v.playState;
    const md = ps?.metadata ?? null;
    const radio = playKindOf(ps) === "radio";
    const art = md?.art_url ?? null;
    if (art !== this.artFor) {
      this.artFor = art;
      this.artPath = null;
      this.clearArtWait();
      if (art) {
        // a new track waits a moment for its sleeve rather than showing the app's icon first
        const until = this.deps.now() + ART_WAIT_MS;
        this.artWaiting = {
          until,
          timer: setTimeout(() => {
            this.artWaiting = null;
            this.update();
          }, ART_WAIT_MS),
        };
        void this.deps
          .artFile(art)
          .catch(() => null)
          .then((file) => {
            // a slow answer for a picture no longer current is dropped
            if (this.artFor !== art) return;
            this.artPath = file;
            this.clearArtWait();
            this.update();
          });
      }
    }
    if (this.artWaiting) return;
    const duration = md?.duration ?? null;
    const can = transportAbilities(v.nowPlaying?.controls, duration);
    const title =
      (radio && md ? (radioTrackTitle(md) ?? md.station) : trackTitle(md)) ?? md?.name ?? "";
    const info: Info = {
      t: "info",
      title,
      artist: (radio ? (md?.station !== title ? md?.station : md?.artist) : md?.artist) ?? "",
      album: md?.album ?? "",
      playing: ps?.state === "play",
      live: radio,
      art: this.artPath ?? this.deps.fallbackArt ?? undefined,
      can: {
        toggle: can.canToggle,
        next: can.canNext,
        previous: can.canPrev,
        seek: can.canSeek,
        stop: can.canStop,
      },
      ...(radio || duration == null ? {} : { duration }),
    };
    // what a reader would see, without the clock
    const shape = JSON.stringify(info);
    const now = this.deps.now();
    const position = radio ? null : v.position;
    const rate = info.playing ? 1 : 0;
    const expected = this.lastElapsed
      ? this.lastElapsed.secs + ((now - this.lastElapsed.at) / 1000) * this.lastElapsed.rate
      : null;
    const drifted =
      position != null && (expected == null || Math.abs(position - expected) > DRIFT_SECS);
    if (shape === this.lastShape && !drifted && this.claimed) return;
    if (position != null) {
      info.elapsed = position;
      this.lastElapsed = { secs: position, at: now, rate };
    } else this.lastElapsed = null;
    this.lastShape = shape;
    if (!this.claimed)
      this.deps.log(`claimed Now Playing (${playKindOf(ps) ?? "a play"} on ${md?.source ?? "?"})`);
    this.claimed = true;
    this.send(info);
  }

  private release(why: string): void {
    this.clearSettle();
    this.clearHold();
    this.claimedSource = null;
    if (!this.claimed) return;
    this.claimed = false;
    this.lastShape = "";
    this.lastElapsed = null;
    this.send({ t: "release" });
    this.deps.log(`let go of Now Playing (${why})`);
  }

  private clearSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private clearHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.holdingSince = null;
  }

  private clearArtWait(): void {
    if (this.artWaiting) clearTimeout(this.artWaiting.timer);
    this.artWaiting = null;
  }

  /** Not used again until the setting is turned off and on; the keys go back to their old route. */
  private giveUp(why: string): void {
    this.deps.log(why);
    this.wanted = false;
    this.givenUp = true;
    this.deps.gaveUp?.();
  }

  private send(o: object): void {
    if (this.child && !this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(o)}\n`);
  }

  private spawn(): void {
    const { file, args = [] } = this.deps.command;
    let child: ChildProcessWithoutNullStreams;
    try {
      // windowsHide: the Windows helper is a console program, and no console window may flash
      child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      this.deps.log(`the helper couldn't start: ${(e as Error).message}`);
      return this.scheduleRestart();
    }
    this.child = child;
    this.ready = false;
    let said = "";
    const hello = setTimeout(() => {
      if (!this.ready) {
        child.kill();
        this.giveUp("the helper never said hello: not used");
      }
    }, HELLO_MS);
    child.on("error", (e) => this.deps.log(`the helper failed: ${e.message}`));
    // its last words, for the log when it ends before its hello
    child.stderr.on("data", (d: Buffer) => {
      said = (said + d.toString()).slice(-400);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!this.ready) {
        clearTimeout(hello);
        if (line.trim() !== HELLO) {
          child.kill();
          this.giveUp(
            `the helper is not one this app speaks to ("${line.slice(0, 60)}"): not used`,
          );
          return;
        }
        this.ready = true;
        this.deps.log("the helper is up");
        this.update();
        return;
      }
      this.heard(line);
    });
    child.on("exit", (code) => {
      clearTimeout(hello);
      if (this.child !== child) return;
      const wasReady = this.ready;
      this.child = null;
      this.ready = false;
      this.claimed = false;
      this.lastShape = "";
      if (!this.wanted) return;
      const last = said.trim().split("\n").at(-1)?.slice(0, 200);
      // ended before its hello: it can't run here, and starting it again won't change that
      if (!wasReady)
        return this.giveUp(
          `the helper ended before its hello (${code ?? "signal"}${last ? `: ${last}` : ""}): not used`,
        );
      this.deps.log(`the helper exited (${code ?? "signal"})`);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (!this.wanted) return;
    const now = this.deps.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS)
      return this.giveUp("the helper keeps exiting: given up until the setting is turned on again");
    const wait = RESTARTS[Math.min(this.restarts.length, RESTARTS.length - 1)];
    this.restarts.push(now);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted && !this.child) this.spawn();
    }, wait);
  }

  private heard(line: string): void {
    const [kind, name, arg] = line.split(" ");
    if (kind === "activate") return this.deps.activate();
    if (kind === "log") return;
    if (kind !== "cmd") return;
    const v = this.deps.view();
    const md = v.playState?.metadata ?? null;
    const can = transportAbilities(v.nowPlaying?.controls, md?.duration ?? null);
    const cmd = commandForMedia(
      name as MediaCommand,
      v.playState?.state ?? null,
      can,
      arg != null ? Number(arg) : undefined,
    );
    this.deps.log(
      `${name}${arg ? ` ${arg}` : ""} from the system: ${cmd ? cmd.type : "nothing to do"}`,
    );
    if (cmd) this.deps.fire(cmd);
  }
}
