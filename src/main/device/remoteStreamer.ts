import type { StreamerCommand } from "@shared/ipc";
import type { MediaQueueAction, SleepTimer } from "@shared/model";
import { queueAdd } from "../media/upnpBrowser";
import { type CommandConnection, openAgain, sendCommand } from "./commandPath";
import { checkFrame } from "./frameCheck";
import { QueueOps } from "./queueOps";
import { recallSignature } from "./recallWatch";
import { SleepCountdown } from "./sleepCountdown";
import { SmoipSocket } from "./smoipSocket";
import * as smoipHttp from "./smoipHttp";
import {
  applyFrame,
  emptyCache,
  presetVolumeFor,
  PresetVolumeAfterRecall,
  type StreamerCache,
} from "./streamerCache";
import { VolumeFader } from "./volumeFader";

/**
 * ANOTHER STREAMER, FOR AN AGENT (0.16.0, the MCP server's more than one streamer). A connection
 * to a streamer the window isn't showing, so an agent can act on it ("pause the kitchen") and
 * the window stays where the user put it. The window's connection is DeviceManager's; this one is
 * built from the same parts: the same SmoipSocket, its frames read by the same rule
 * (streamerCache's applyFrame), its commands the same commandFrames (the one volume limit applies
 * to every streamer), its queue writes the same QueueOps, its sleep timer the same SleepCountdown
 * and fade. It records no listening (the record stays the window's streamer's), pushes nothing to
 * any window, and closes when an agent has left it idle, unless a sleep timer is armed on it.
 */
export class RemoteStreamer {
  readonly cache: StreamerCache = emptyCache();
  /** Last asked (an idle connection closes, RemoteStreamers.sweep). */
  lastUsed = Date.now();
  private readonly socket: SmoipSocket;
  private wakePromise: Promise<void> | null = null;

  readonly fader = new VolumeFader({
    level: () => this.cache.zoneState?.volume_percent ?? null,
    write: (percent) => this.command({ type: "setVolumePercent", percent }),
    connected: () => this.socket.isOpen(),
    log: (text) => this.log(`sleep: ${text}`),
  });
  readonly sleeper = new SleepCountdown({
    fader: this.fader,
    connected: () => this.socket.isOpen(),
    command: (cmd) => this.command(cmd),
    push: () => {},
    log: (text) => this.log(`sleep: ${text}`),
  });
  // a recall's own level, sent once the recall lands, as the window's connection sends it
  private readonly presetLevel = new PresetVolumeAfterRecall({
    signature: () => recallSignature(this.cache.playState),
    apply: (percent) => void this.command({ type: "setVolumePercent", percent }).catch(() => {}),
  });
  // this connection to the shared command rules (device/commandPath), the window's own: the fade
  // take-over, the wake first and the wait for the socket after it, the plain writes
  private readonly path: CommandConnection = {
    cache: () => this.cache,
    socket: () => this.socket,
    fader: this.fader,
    presetLevel: this.presetLevel,
    ensureAwake: () => this.ensureAwake(),
    socketBack: (socket) => openAgain(socket),
    refuse: () => new Error(`${this.name} isn't connected right now.`),
  };
  readonly queueOps = new QueueOps({
    host: () => (this.socket.isOpen() ? this.host : null),
    socket: () => this.socket,
    queue: () => this.cache.queue,
    push: () => {},
    ensureAwake: () => this.ensureAwake(),
  });

  constructor(
    readonly host: string,
    private readonly log: (text: string) => void,
  ) {
    this.socket = new SmoipSocket(host, {
      onFrame: (frame) => {
        const raw = frame.params?.data;
        if (raw === undefined) return;
        const checked = checkFrame(frame.path, raw);
        if (!checked.ok) return;
        applyFrame(this.cache, frame.path, checked.data);
        if (frame.path === "/zone/play_state" && this.cache.playState) {
          this.sleeper.boundaryCheck(this.cache.playState);
          this.presetLevel.onPlayback();
        }
      },
      onOutgoing: () => {},
      onConnecting: () => {},
      onConnected: () => {
        // the capability specs a command reads (tone, power), and the presets, over HTTP as the
        // window's connection fetches them
        void smoipHttp.getAudioSpec(host).then((spec) => {
          this.cache.audioSpec = (spec as StreamerCache["audioSpec"]) ?? null;
        });
        void smoipHttp.getPowerSpec(host).then((spec) => {
          this.cache.powerSpec = (spec as StreamerCache["powerSpec"]) ?? null;
        });
        void this.refreshPresets();
      },
      onDisconnected: () => {},
      onLog: (level, text) => {
        if (level !== "info") this.log(text);
      },
    });
    this.socket.connect();
  }

  /** The streamer's name as it says it, else its host. */
  get name(): string {
    return this.cache.systemInfo?.name ?? this.host;
  }

  /** Connected and known: the socket open and the streamer's identity and state in hand, waited
   *  for up to `ms`. Then, within the same wait, its power, what it is playing and its queue,
   *  which arrive a moment after (0.16.0 answered without them: a first list_queue read an empty
   *  queue for a full one, and a power-on went to a streamer already on); a model that never
   *  sends one of them is still ready once the wait is up. */
  async ready(ms = 6000): Promise<boolean> {
    const until = Date.now() + ms;
    const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 100));
    const isReady = (): boolean =>
      this.socket.isOpen() && this.cache.systemInfo != null && this.cache.zoneState != null;
    const settled = (): boolean =>
      this.cache.systemPower != null && this.cache.playState != null && this.cache.queue != null;
    while (!isReady() && Date.now() < until) await pause();
    if (!isReady()) return false;
    while (!settled() && this.socket.isOpen() && Date.now() < until) await pause();
    return this.socket.isOpen();
  }

  /** After the computer wakes: the socket's liveness checked, and a sleep timer that came due
   *  during the sleep fired, as the window's connection does both. */
  resumed(): void {
    void this.socket.healthCheck();
    this.sleeper.checkSleepTimer();
  }

  async refreshPresets(): Promise<void> {
    try {
      const data = await smoipHttp.getPresets(this.host);
      if (data != null) this.cache.presets = data as StreamerCache["presets"];
    } catch {
      // the list stays as it was
    }
  }

  /** Wake-on-intent, as the window's connection does it: ON, the power push (a timed fallback
   *  for a lost one), then the settle for the zone. Single-flight. */
  async ensureAwake(): Promise<void> {
    if (this.cache.systemPower == null || this.cache.systemPower.power === "ON") return;
    if (this.wakePromise) return this.wakePromise;
    this.wakePromise = (async () => {
      try {
        await this.command({ type: "power", power: "ON" });
        const deadline = Date.now() + 8000;
        while (this.cache.systemPower?.power !== "ON" && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 200));
        await new Promise((r) => setTimeout(r, 2500));
      } finally {
        this.wakePromise = null;
      }
    })();
    return this.wakePromise;
  }

  /** A command, by the rules the window's commands follow (device/commandPath: the fade take-over,
   *  the wake first for a play-shaped one and the wait after it, the plain writes), then the
   *  preset's volume after a recall. The verbs an agent sends another streamer; the rest are the
   *  window's. */
  async command(cmd: StreamerCommand): Promise<void> {
    this.lastUsed = Date.now();
    const socket = await sendCommand(this.path, cmd);
    if (!socket) return;
    switch (cmd.type) {
      case "recallPreset": {
        socket.send("/zone/recall_preset", { preset: cmd.presetId });
        const name = this.cache.presets?.presets?.find((p) => p.id === cmd.presetId)?.name;
        this.presetLevel.recalled(
          cmd.skipVolume ? null : presetVolumeFor(this.cache.systemInfo?.udn, cmd.presetId, name),
          cmd.alreadyPlaying === true,
        );
        return;
      }
      case "streamRadio":
        return smoipHttp.streamRadio(this.host, cmd.url, cmd.name);
      case "queueClear":
        return smoipHttp.queueClear(this.host);
      case "queueDelete":
        return smoipHttp.queueDelete(this.host, cmd.id);
      case "queueMove":
        return smoipHttp.queueMove(this.host, cmd.id, cmd.from, cmd.to);
      default:
        throw new Error(
          `That isn't available for another streamer: switch to it with connect_device.`,
        );
    }
  }

  /** A library item into this streamer's queue, woken first, as DeviceManager.queueAdd does it
   *  for the window's (the one other home of the media browser's queue write: lint
   *  queue-add-wakes). */
  async queueAdd(
    serverUdn: string,
    objectId: string,
    action: MediaQueueAction,
    playFromId?: string,
    opts?: { confirmLarge?: boolean },
  ): Promise<void> {
    if (action !== "APPEND" && action !== "PLAY_NEXT") this.presetLevel.cancel();
    await this.ensureAwake();
    this.lastUsed = Date.now();
    await queueAdd(this.host, serverUdn, objectId, action, playFromId, opts);
  }

  /** The pre-amp level a fade starts from, as the window's connection reads it. */
  preAmpVolume(): number | null {
    return this.cache.zoneState?.volume_percent ?? null;
  }

  fadeInTo(target: number): Promise<void> {
    return this.fader.fadeInTo(target);
  }

  setSleep(sleep: SleepTimer | null): void {
    this.lastUsed = Date.now();
    this.sleeper.setSleep(sleep);
  }

  close(): void {
    this.sleeper.stop();
    this.presetLevel.cancel();
    this.socket.close();
  }
}

/** How long an agent's connection to another streamer stays open with nothing asked of it. */
export const REMOTE_IDLE_MS = 5 * 60_000;
/** How many other streamers an agent's connections reach at once (a home has a few). */
export const REMOTE_MAX = 4;

/** The agent's connections to other streamers, one per host, opened when asked for and closed
 *  when idle (a sleep timer armed on one keeps it open until it fires). */
export class RemoteStreamers {
  private readonly open = new Map<string, RemoteStreamer>();
  private sweeper: NodeJS.Timeout | null = null;

  /** Where the pool's notes go (the bridge points it at the app's log). */
  log: (text: string) => void = () => {};

  /** The connection to `host`, opened if need be. At most REMOTE_MAX are open: a new one closes
   *  the least recently used without a sleep timer armed, and is refused when every one has one. */
  get(host: string): RemoteStreamer {
    let remote = this.open.get(host);
    if (!remote) {
      if (this.open.size >= REMOTE_MAX) {
        const idle = [...this.open.entries()]
          .filter(([, r]) => r.sleeper.current == null)
          .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
        if (!idle)
          throw new Error(
            `An agent has ${REMOTE_MAX} other streamers open, each with a sleep timer set, the most at once.`,
          );
        idle[1].close();
        this.open.delete(idle[0]);
        this.log(`closed the connection to ${idle[0]}, the least recently used, for ${host}`);
      }
      remote = new RemoteStreamer(host, (text) => this.log(`${host}: ${text}`));
      this.open.set(host, remote);
      this.log(`opened a connection to ${host} for an agent`);
    }
    remote.lastUsed = Date.now();
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), 60_000);
      this.sweeper.unref();
    }
    return remote;
  }

  /** The connections open now (get_status names them). */
  hosts(): string[] {
    return [...this.open.keys()];
  }

  /** A connection that didn't become ready (no streamer there, or one that isn't answering)
   *  closes now rather than retrying until the idle sweep, unless a sleep timer is armed on it. */
  forget(host: string): void {
    const remote = this.open.get(host);
    if (!remote || remote.sleeper.current != null) return;
    remote.close();
    this.open.delete(host);
    this.log(`closed the connection to ${host}: no streamer answered`);
  }

  /** The computer woke: each open connection checked, and its sleep timer (0.16.0: only the
   *  window's was, so a timer on another streamer that came due during the sleep fired late). */
  resumed(): void {
    for (const remote of this.open.values()) remote.resumed();
  }

  /** Closes the connections an agent has left idle, none with a sleep timer armed. */
  sweep(now = Date.now()): void {
    for (const [host, remote] of this.open)
      if (now - remote.lastUsed > REMOTE_IDLE_MS && remote.sleeper.current == null) {
        remote.close();
        this.open.delete(host);
        this.log(`closed the idle connection to ${host}`);
      }
    if (this.open.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  /** The window moved to a streamer an agent had open: the window's connection serves it now. The
   *  sleep timer an agent armed on it is handed back, for the window's connection to take over
   *  (0.16.0: it closed with the connection, unsaid). */
  drop(host: string): SleepTimer | null {
    const remote = this.open.get(host);
    if (!remote) return null;
    const sleep = remote.sleeper.current;
    remote.close();
    this.open.delete(host);
    return sleep;
  }

  /** The agent server off: every connection closes but one with a sleep timer armed, which the
   *  sweep closes once its timer has fired and it sits idle (0.16.0: the timer died with it). */
  closeAll(): void {
    for (const [host, remote] of this.open) {
      if (remote.sleeper.current != null) continue;
      remote.close();
      this.open.delete(host);
    }
    if (this.open.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }
}

/** The one pool, which the MCP bridge and the scheduler both reach: one connection per streamer. */
export const remoteStreamers = new RemoteStreamers();
