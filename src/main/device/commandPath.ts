import type { StreamerCommand } from "@shared/ipc";
import { getSettings } from "../data/persist";
import { askedAfter, type AskedVolume, commandFrames } from "./commandFrames";
import type { SmoipSocket } from "./smoipSocket";
import { type PresetVolumeAfterRecall, type StreamerCache, WAKE_COMMANDS } from "./streamerCache";
import type { VolumeFader } from "./volumeFader";

/**
 * ONE COMMAND PATH. The rules every streamer command follows, whichever connection sends it: the
 * window's (DeviceManager) or an agent's to another streamer (RemoteStreamer). A volume, power or
 * transport command takes over from a running fade; a socket that isn't open refuses it, loudly; a
 * play-shaped command wakes a sleeping streamer first and waits for the socket to be back after the
 * wake; and a plain write goes out as commandFrames builds it, under the one volume limit. Kept in
 * two copies, the agent's had lost the fade take-over (a volume set during a schedule's fade was
 * undone by the fade's next step) and the wait after a wake (a recall could answer done with
 * nothing sent). What isn't a plain write comes back to the connection, which owns its own verbs.
 */

/** The commands that take over from a running fade: the level the user (or an agent) sets wins. */
export const FADE_TAKEOVER: ReadonlySet<StreamerCommand["type"]> = new Set([
  "setVolumePercent",
  "setVolumeStep",
  "volumeStepChange",
  "power",
  "pause",
  "play",
  "togglePlayback",
]);

/**
 * THE ASKED LEVEL, PER CONNECTION (commandFrames' AskedVolume): kept beside the connection's cache,
 * so a new connection (a new cache) starts with none, and every caller of the one path (the window,
 * the menu, a link, an agent, another screen) raises the same one. It stands until the streamer's
 * next zone state replaces the one it was raised over: the streamer has reported its level again.
 */
const asked = new WeakMap<
  StreamerCache,
  { level: AskedVolume; over: StreamerCache["zoneState"] }
>();

function askedNow(cache: StreamerCache): AskedVolume | null {
  const a = asked.get(cache);
  if (a && a.over === cache.zoneState) return a.level;
  asked.delete(cache);
  return null;
}

/** Why a command didn't go out. */
export type CommandRefusal = "no connection" | "not open" | "not open after the wake";

/** What the command path needs of a connection. */
export interface CommandConnection {
  /** What the streamer is doing now (the frames a command builds read it). */
  cache(): StreamerCache;
  /** The socket commands go out on now, or null with none. */
  socket(): SmoipSocket | null;
  readonly fader: VolumeFader;
  readonly presetLevel: PresetVolumeAfterRecall;
  /** Wake-on-intent for the command, single-flight. */
  ensureAwake(cmd: StreamerCommand): Promise<void>;
  /** After a wake: the same socket open again within a moment. */
  socketBack(socket: SmoipSocket): Promise<boolean>;
  /** The error a refused command throws (the connection's own words), or null to drop it quietly. */
  refuse(cmd: StreamerCommand, why: CommandRefusal): Error | null;
}

/** The socket open again within `ms`, while `still` holds (false once another takes its place). */
export async function openAgain(
  socket: SmoipSocket,
  still: () => boolean = () => true,
  ms = 5000,
): Promise<boolean> {
  const until = Date.now() + ms;
  while (still() && !socket.isOpen() && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return still() && socket.isOpen();
}

/**
 * Sends a command by the shared rules. Null when nothing more is to be done (sent as frames, or
 * dropped quietly); the open socket when the command is one of the connection's own verbs.
 */
export async function sendCommand(
  conn: CommandConnection,
  cmd: StreamerCommand,
): Promise<SmoipSocket | null> {
  conn.presetLevel.onCommand(cmd.type);
  // the fade engine's own writes are flagged (not interruptible) and pass through
  if (conn.fader.interruptible && FADE_TAKEOVER.has(cmd.type)) conn.fader.cancelFade(false);
  const refused = (why: CommandRefusal): null => {
    const error = conn.refuse(cmd, why);
    if (error) throw error;
    return null;
  };
  const socket = conn.socket();
  if (!socket) return refused("no connection");
  // a half-dead socket (closed or mid-reconnect) once swallowed commands silently: the preset
  // card marked, nothing played; a refusal is said instead
  if (!socket.isOpen()) return refused("not open");
  const power = conn.cache().systemPower;
  if (WAKE_COMMANDS.has(cmd.type) && power != null && power.power !== "ON") {
    await conn.ensureAwake(cmd);
    // the wake takes seconds, and the connection can drop and reconnect across it (or another
    // streamer be chosen meanwhile): never a write into a closed socket
    if (!(await conn.socketBack(socket))) return refused("not open after the wake");
  }
  // PASSIVE-ONLY firmware policy (deliberate): no command sends /system/update with an action. The
  // app only subscribes to it (smoipSocket SUBSCRIBED_PATHS) to show whether an update is
  // available; checking for or installing firmware stays the Cambridge Audio app's or the
  // streamer's own web admin's. No firmware check or install belongs here or in commandFrames.
  const cache = conn.cache();
  const state = {
    nowPlaying: cache.nowPlaying,
    playState: cache.playState,
    zoneState: cache.zoneState,
    systemPower: cache.systemPower,
    audioSpec: cache.audioSpec,
    powerSpec: cache.powerSpec,
    volumeLimitPercent: getSettings().volumeLimitPercent,
    askedVolume: askedNow(cache),
  };
  const frames = commandFrames(cmd, state);
  if (frames) {
    // a volume write raises the asked level as it goes, before the streamer answers
    const level = askedAfter(frames, state);
    if (level) asked.set(cache, { level, over: cache.zoneState });
    for (const f of frames) socket.send(f.path, f.params);
    return null;
  }
  return socket;
}
