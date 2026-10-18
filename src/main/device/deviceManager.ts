// Orchestrates discovery, the SMOIP socket, command dispatch, and the push relay
// to renderer windows. Mirrors PunyTunes' StreamMagicManager, translated to Node.

import { webContents, type WebContents } from "electron";
import { type PushMessage, type Snapshot, type StreamerCommand } from "@shared/ipc";
import {
  presetVolumeKey,
  type ConnectionState,
  type DiscoveredDevice,
  type FirmwareStatus,
  type FrameEntry,
  type LogEntry,
  type McpStatus,
  type MediaIndexStatus,
  type MissedSchedule,
  type SleepTimer,
  FRAME_RING_SIZE,
  LOG_RING_SIZE,
} from "@shared/model";
import {
  type ContentRef,
  type KnownDevice,
  type PlaylistActivation,
  type QueueRestoreResult,
  KNOWN_DEVICES_MAX,
  RECONNECT_GRACE_MS,
  type HeldState,
} from "@shared/model";
import type {
  Presets,
  QueueList,
  SmoipFrame,
  SystemInfo,
  SystemPower,
  SystemDisplay,
  SystemDisplaySpec,
  SystemPowerSpec,
  SystemSources,
  SystemUpdate,
  ZoneAudio,
  ZoneAudioSpec,
  ZoneNowPlaying,
  ZonePlayState,
  ZonePosition,
  ZoneState,
} from "@shared/smoip";
import { discoverStreamers } from "./discovery";
import { SmoipSocket } from "./smoipSocket";
import * as smoipHttp from "./smoipHttp";
import { getSettings, updateSettings } from "../data/persist";
import { getRecents } from "../data/recents";
import { decorateRecents } from "../lookups/recentArt";
import { listeningRecord } from "../data/listeningRecord";
import { getFavorites } from "../data/favorites";
import { getPlaylists } from "../data/playlists";
import { QueueOps } from "./queueOps";
import { Collections } from "./collections";
import { commandFrames } from "./commandFrames";
import { SleepCountdown } from "./sleepCountdown";
import { TrackNotifier } from "./trackNotifier";
import { VolumeFader } from "./volumeFader";
import { heldFor, heldFrom, saveHeld } from "./heldState";
import type { ResolvedContent } from "../media/resolveContent";
import { scrobbler } from "../lookups/scrobbler";
import { getNetRequests } from "../netlog";
import { errorMessage } from "@shared/guards";

interface Cache {
  playState: ZonePlayState | null;
  position: ZonePosition | null;
  nowPlaying: ZoneNowPlaying | null;
  zoneState: ZoneState | null;
  queue: QueueList | null;
  presets: Presets | null;
  systemInfo: SystemInfo | null;
  systemPower: SystemPower | null;
  firmwareUpdate: FirmwareStatus | null;
  sources: SystemSources | null;
  zoneAudio: ZoneAudio | null;
  audioSpec: ZoneAudioSpec | null;
  systemDisplay: SystemDisplay | null;
  displaySpec: SystemDisplaySpec | null;
  powerSpec: SystemPowerSpec | null;
}

const emptyCache = (): Cache => ({
  playState: null,
  position: null,
  nowPlaying: null,
  zoneState: null,
  queue: null,
  presets: null,
  systemInfo: null,
  systemPower: null,
  firmwareUpdate: null,
  sources: null,
  zoneAudio: null,
  audioSpec: null,
  systemDisplay: null,
  displaySpec: null,
  powerSpec: null,
});

export class DeviceManager {
  private socket: SmoipSocket | null = null;
  private connection: ConnectionState = { phase: "idle" };
  private devices: DiscoveredDevice[] = [];
  private discovering = false;
  private cache: Cache = emptyCache();
  private frames: FrameEntry[] = [];
  private logs: LogEntry[] = [];
  private lastHealthCheckAt = 0;
  private lastSourceId: string | null = null;
  private queuePresetsTimer: NodeJS.Timeout | null = null;
  /** Connected to the in-process demo device (labels the connection in the UI). */
  private demo = false;
  /** See Snapshot.lastRecalledPresetId — in-app recalls only, content-checked by consumers. */
  private lastRecalledPresetId: number | null = null;
  private mcpStatus: McpStatus = { running: false, url: null, error: null };
  private missedSchedule: MissedSchedule | null = null;
  private mediaIndexStatuses: MediaIndexStatus[] = [];
  /**
   * When the current connection FIRST failed (null = never / healthy).
   * The socket oscillates connecting ↔ disconnected while it retries, so this
   * stamps the start of the whole outage, not the latest attempt. Past
   * RECONNECT_GRACE_MS the outage counts as STRANDED: the device is treated
   * as gone (eco standby never comes back on its own) and the sweep's
   * single-candidate courtesy may switch to the one streamer that IS alive.
   * Cleared on connect success, on a new manual target, and on deliberate
   * disconnect — a user who chose to disconnect asked for silence, not a
   * search party.
   */
  private disconnectedSince: number | null = null;
  /** The periodic sweep that runs while not connected — see ensureRediscover. */
  private rediscoverTimer: NodeJS.Timeout | null = null;

  // ------------------------------------------------------------------ lifecycle

  /** Reconnect to the last-used streamer immediately; discover in parallel. */
  async startup(): Promise<void> {
    const { lastHost } = getSettings();
    if (lastHost) this.connect(lastHost);
    // Arm the not-connected sweep even when there is no lastHost to chase —
    // connect() is what normally starts it, and a first run never calls it.
    this.ensureRediscover();
    await this.discover();
  }

  async discover(): Promise<DiscoveredDevice[]> {
    if (this.discovering) return this.devices;
    this.discovering = true;
    this.pushDevices();
    try {
      this.devices = await discoverStreamers();
      this.log("info", "discovery", `found ${this.devices.length} streamer(s)`);
    } catch (err) {
      this.log("error", "discovery", `discovery failed: ${(err as Error).message}`);
    } finally {
      this.discovering = false;
      this.pushDevices();
    }
    // A sweep that SEES a remembered streamer refreshes its entry — the
    // address is a hint, the UDN is the identity, so a DHCP reassignment
    // self-heals here without a connect.
    this.refreshKnownFromSweep();
    // Never-connected + idle + something found -> just connect. Lives here
    // (not only in startup) so the connect gate's auto-retry sweeps get the
    // same courtesy — a streamer that boots a minute after the app does is
    // picked up hands-free on a first run.
    if (!getSettings().lastHost && this.connection.phase === "idle" && this.devices.length > 0) {
      this.connect(this.devices[0].host);
    } else {
      // The STRANDED courtesy (the multi-streamer eco report, 2026-08-30):
      // the current target has been gone past the grace — eco standby powers
      // its network off, so it is not coming back on its own — and the sweep
      // finds exactly ONE streamer that isn't it. Connecting to the only
      // streamer alive is the better default; two or more candidates are a
      // choice, so they get listed, never guessed at.
      const failingHost =
        this.connection.phase === "connecting" || this.connection.phase === "disconnected"
          ? this.connection.host
          : null;
      const stranded =
        this.disconnectedSince != null && Date.now() - this.disconnectedSince >= RECONNECT_GRACE_MS;
      if (
        stranded &&
        failingHost != null &&
        this.devices.length === 1 &&
        this.devices[0].host !== failingHost
      ) {
        this.log(
          "info",
          "discovery",
          `${failingHost} has been gone ${Math.round((Date.now() - (this.disconnectedSince ?? 0)) / 1000)}s — switching to ${this.devices[0].friendlyName} (${this.devices[0].host}), the one streamer answering`,
        );
        this.connect(this.devices[0].host);
      }
    }
    return this.devices;
  }

  /**
   * Keep sweeping while not connected, so a streamer that powers on later is
   * noticed without anyone clicking anything — the manager owns this (not the
   * connect gate) because the gate only sweeps while mounted and visible,
   * which is exactly what stranded the multi-streamer household. Idle after a
   * deliberate disconnect still sweeps (the gate lists what it finds) but
   * auto-connects nowhere: both courtesies carry their own guards.
   */
  private ensureRediscover(): void {
    if (this.connection.phase === "connected") {
      if (this.rediscoverTimer) {
        clearInterval(this.rediscoverTimer);
        this.rediscoverTimer = null;
      }
      return;
    }
    if (this.rediscoverTimer) return;
    this.rediscoverTimer = setInterval(() => void this.discover(), 10_000);
    this.rediscoverTimer.unref?.();
  }

  /** Upsert one streamer into the device book: newest-first, UDN-keyed, LRU-capped. */
  private rememberDevice(dev: Omit<KnownDevice, "lastSeenAt">): void {
    if (!dev.udn) return; // identity or nothing — a host alone can't be remembered safely
    const rest = getSettings().knownDevices.filter((d) => d.udn !== dev.udn);
    const knownDevices = [{ ...dev, lastSeenAt: Date.now() }, ...rest].slice(0, KNOWN_DEVICES_MAX);
    this.push({ kind: "settings", settings: updateSettings({ knownDevices }) });
  }

  private refreshKnownFromSweep(): void {
    const known = getSettings().knownDevices;
    for (const seen of this.devices) {
      const match = seen.udn ? known.find((d) => d.udn === seen.udn) : undefined;
      if (match) {
        this.rememberDevice({
          udn: match.udn,
          host: seen.host,
          friendlyName: seen.friendlyName || match.friendlyName,
          model: seen.model || match.model,
        });
      }
    }
  }

  connect(host: string, opts?: { remember?: boolean; demo?: boolean }): void {
    // Renderer surfaces label the connection ("built-in demo") off this flag.
    this.demo = opts?.demo === true;
    // A recall remembered from one device means nothing on another.
    this.setRecalledPreset(null);
    // A timer armed for one device must never act on another.
    if (this.sleeper.current && this.socket && this.socket.host !== host) this.setSleep(null);
    this.socket?.close();
    this.cache = emptyCache();
    this.trackNotifier.reset();
    this.lastSourceId = null;
    // The demo device passes remember:false — its ephemeral loopback port
    // must never become the reconnect target of the next launch.
    if (opts?.remember !== false) updateSettings({ lastHost: host });
    // A new target is a fresh benefit of the doubt.
    this.disconnectedSince = null;

    // Callbacks from a replaced socket must be ignored: its async close event
    // would otherwise stomp the new connection's state.
    const isCurrent = (socket: SmoipSocket): boolean => this.socket === socket;

    const socket: SmoipSocket = new SmoipSocket(host, {
      onFrame: (frame) => {
        if (isCurrent(socket)) this.handleFrame(frame);
      },
      onOutgoing: (frame) => {
        if (isCurrent(socket)) this.recordFrame("out", frame);
      },
      onConnecting: (attempt) => {
        if (isCurrent(socket)) this.setConnection({ phase: "connecting", host, attempt });
      },
      onConnected: () => {
        if (isCurrent(socket)) {
          this.disconnectedSince = null;
          this.setConnection({ phase: "connected", host });
          // Capability probes — refreshed every (re)connect. The /spec
          // endpoints aren't proven over the WS, so they ride HTTP like presets.
          void this.probeAudioSpec(socket);
          void this.probeSystemSpecs(socket);
        }
      },
      onDisconnected: (reason, reconnecting) => {
        if (isCurrent(socket)) {
          // Stamp the START of the outage — the socket oscillates
          // connecting ↔ disconnected while retrying, and the stranded
          // clock must measure the whole silence, not the latest attempt.
          if (reconnecting && this.disconnectedSince == null) this.disconnectedSince = Date.now();
          this.setConnection({ phase: "disconnected", host, reason, reconnecting });
        }
      },
      onLog: (level, text) => {
        if (isCurrent(socket)) this.log(level, "socket", text);
      },
    });
    this.socket = socket;
    socket.connect();
  }

  disconnect(): void {
    if (this.sleeper.current) this.setSleep(null);
    this.socket?.close();
    this.socket = null;
    this.cache = emptyCache();
    this.demo = false;
    this.setRecalledPreset(null);
    // Deliberate — no outage clock, no stranded courtesy.
    this.disconnectedSince = null;
    this.setConnection({ phase: "idle" });
  }

  /** Whether `socket` is still this manager's and open, waiting up to `ms` for a reconnect. */
  private async socketBack(socket: SmoipSocket, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms;
    while (this.socket === socket && !socket.isOpen() && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.socket === socket && socket.isOpen();
  }

  /** Rate-limited liveness probe, run on window focus and system resume. */
  healthCheck(): void {
    const now = Date.now();
    if (now - this.lastHealthCheckAt < 5000) return;
    this.lastHealthCheckAt = now;
    void this.socket?.healthCheck();
  }

  shutdown(): void {
    this.sleeper.stop();
    this.socket?.close();
    this.socket = null;
  }

  // ---------------------------------------------------------------- volume fade

  /** The volume fade (sleep fade-out, schedule fade-in), pre-amp mode only; see volumeFader.ts. */
  private readonly fader = new VolumeFader({
    level: () => this.preAmpVolume(),
    write: (percent) => this.command({ type: "setVolumePercent", percent }),
    connected: () => this.connection.phase === "connected",
    log: (text) => this.log("info", "sleep", text),
  });

  /** Current pre-amp level, or null when the device is in control-bus mode (no fades there). */
  preAmpVolume(): number | null {
    return this.cache.zoneState?.volume_percent ?? null;
  }

  /** A wake schedule's fade-in: ramp from the pre-set low level up to `target`. */
  fadeInTo(target: number): Promise<void> {
    return this.fader.fadeInTo(target);
  }

  // ---------------------------------------------------------------- sleep timer

  /** The sleep timer, in main so it survives the window closing; see sleepCountdown.ts. */
  private readonly sleeper = new SleepCountdown({
    fader: this.fader,
    connected: () => this.connection.phase === "connected",
    command: (cmd) => this.command(cmd),
    push: (msg) => this.push(msg),
    log: (text) => this.log("info", "sleep", text),
  });

  /** Arm or clear the sleep timer. */
  setSleep(sleep: SleepTimer | null): void {
    this.sleeper.setSleep(sleep);
  }

  /** Fire a countdown that came due while the system was asleep (on resume). */
  checkSleepTimer(): void {
    this.sleeper.checkSleepTimer();
  }

  // ------------------------------------------------------------------- commands

  /** Play-shaped commands that should wake a standby streamer first. */
  private static readonly WAKE_COMMANDS = new Set<StreamerCommand["type"]>([
    "play",
    "togglePlayback",
    "playQueueId",
    "recallPreset",
    "streamRadio",
    "setSource",
  ]);
  private wakePromise: Promise<void> | null = null;
  /** The live copy of what the streamer is doing (see HeldState and noteHeld). */
  private live: HeldState | null = null;
  private liveKey: string | null = null;

  /** What a wake-on-intent asks for, by name, when its verb names it: the preset's name (from
   *  the cached list) or the station's. The renderer's wake hold reads it to tell the asked
   *  thing's arrival from the device re-announcing what it held through standby. */
  private askedBy(cmd: StreamerCommand): string | null {
    if (cmd.type === "recallPreset")
      return this.cache.presets?.presets?.find((p) => p.id === cmd.presetId)?.name ?? null;
    if (cmd.type === "streamRadio") return cmd.name || null;
    return null;
  }

  /**
   * Wake-on-intent: bring a NETWORK-standby streamer to ON and wait for the
   * zone to be usable. Single-flight — concurrent intents share one wake.
   * FIRMWARE TRUTH (live-probed 2026-07-23): play verbs do NOT auto-wake;
   * standby refuses them with code 114, so the app must sequence ON → act.
   * The 2.5s settle is the scheduler's proven runway before recalls.
   */
  async ensureAwake(asked: string | null = null): Promise<void> {
    if (this.cache.systemPower == null || this.cache.systemPower.power === "ON") return;
    if (this.wakePromise) return this.wakePromise;
    this.wakePromise = (async () => {
      this.push({ kind: "waking", waking: true, asked });
      try {
        await this.command({ type: "power", power: "ON" });
        // Event-driven readiness: the power push flips the cache; the timed
        // fallback covers a lost push. Then the settle for the zone/source.
        const deadline = Date.now() + 8000;
        while (this.cache.systemPower?.power !== "ON" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        await new Promise((r) => setTimeout(r, 2500));
      } finally {
        this.push({ kind: "waking", waking: false });
        this.wakePromise = null;
      }
    })();
    return this.wakePromise;
  }

  /** Keeps the live copy of what the streamer is doing (see HeldState), saved whenever what
   *  it is doing changes (a track, a station, a source), so a standby the app never saw (it
   *  was closed first) still has an offer; the position is saved at the standby itself. */
  private noteHeld(): void {
    const h = heldFrom({
      streamer: this.cache.systemInfo?.udn ?? null,
      power: this.cache.systemPower?.power ?? null,
      playState: this.cache.playState ?? null,
      nowPlaying: this.cache.nowPlaying ?? null,
      zoneState: this.cache.zoneState ?? null,
      sources: this.cache.sources ?? null,
      position: this.cache.position?.position ?? null,
      via: listeningRecord.currentVia(),
      now: Date.now(),
    });
    if (!h) return;
    this.live = h;
    const key = [h.streamer, h.kind, h.sourceId, h.queueId, h.title].join("|");
    if (key === this.liveKey) return;
    this.liveKey = key;
    saveHeld(h, !this.demo);
  }

  /** The streamer went to sleep: what it was doing, with the latest position, is the offer. */
  private holdAtStandby(): void {
    if (!this.live) return;
    saveHeld(this.live, !this.demo);
    this.push({ kind: "held", held: this.live });
  }

  /**
   * RESUME PUTS THE STREAMER BACK AS IT WAS (0.10.0, user ask 2026-10-06; see HeldState). Wake
   * it, come back on the held source if it woke on another (a TV on HDMI pulls it onto ARC),
   * and for a queue track play the same entry and seek to where it was: the Evo keeps the
   * entry through standby but not the position (live-probed 2026-10-06), so the position is
   * the app's. Nothing is added to the queue, and a preset is never recalled again (that
   * would start its first track). A station reconnects by itself and is only asked when it
   * waits; a streaming service or an input needs nothing but its source (AirPlay comes back
   * with no track: the session lived on the phone).
   */
  private async resumeHeld(socket: SmoipSocket): Promise<void> {
    const held = heldFor(this.cache.systemInfo?.udn ?? null);
    if (!held) throw new Error("nothing to resume");
    await this.ensureAwake();
    const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
      const end = Date.now() + ms;
      while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 150));
      return ok();
    };
    if (this.cache.zoneState?.source !== held.sourceId) {
      socket.send("/zone/state", { source: held.sourceId });
      await until(() => this.cache.zoneState?.source === held.sourceId, 5000);
    }
    if (held.kind === "radio") {
      await until(
        () => !["ready", "stop", "pause"].includes(this.cache.playState?.state ?? ""),
        3000,
      );
      const st = this.cache.playState?.state;
      if (st === "ready" || st === "stop" || st === "pause")
        socket.send("/zone/play_control", { action: "play" });
      return;
    }
    if (held.kind !== "queue" || held.queueId == null) return;
    // the queue changed while it slept (another controller): play what the streamer holds
    if (!(this.cache.queue?.items ?? []).some((i) => i.id === held.queueId)) {
      socket.send("/zone/play_control", { action: "play" });
      return;
    }
    if (this.cache.playState?.queue_id === held.queueId)
      socket.send("/zone/play_control", { action: "play" });
    else socket.send("/zone/play_control", { queue_id: held.queueId });
    const at = Math.round(held.position ?? 0);
    if (at < 5 || (held.duration != null && at > held.duration - 5)) return;
    const playing = await until(
      () =>
        this.cache.playState?.state === "play" && this.cache.playState.queue_id === held.queueId,
      8000,
    );
    if (playing) socket.send("/zone/play_control", { position: at });
  }

  /**
   * A command nobody waits for: a menu item, a media key, a timer. command()
   * throws when the socket is not open (a media key pressed while
   * disconnected), and a rejection with nobody to catch it is lost, so the
   * failure goes to the log instead.
   */
  fire(cmd: StreamerCommand): void {
    this.command(cmd).catch((e: unknown) =>
      this.log("warn", "command", `${cmd.type} did not go out: ${errorMessage(e)}`),
    );
  }

  /** A rejection main never caught, kept in the log where the diagnostics show it. */
  logUnhandled(reason: unknown): void {
    this.log("error", "main", `unhandled rejection: ${errorMessage(reason)}`);
  }

  async command(cmd: StreamerCommand): Promise<void> {
    // A user touching volume, power or transport takes over from a running
    // fade — cancel it without restoring (their level wins). The fade engine's
    // own writes are flagged and pass through.
    if (
      this.fader.interruptible &&
      (cmd.type === "setVolumePercent" ||
        cmd.type === "setVolumeStep" ||
        cmd.type === "volumeStepChange" ||
        cmd.type === "power" ||
        cmd.type === "pause" ||
        cmd.type === "play" ||
        cmd.type === "togglePlayback")
    ) {
      this.fader.cancelFade(false);
    }
    const socket = this.socket;
    const host = socket?.host;
    if (!socket || !host) {
      this.log("warn", "command", `ignored ${cmd.type} — not connected`);
      return;
    }
    // A half-dead socket (closed or mid-reconnect) used to swallow commands
    // silently — the user clicks a preset, the card marks, nothing plays.
    // Fail loudly instead so the renderer's central catch can toast it.
    if (!socket.isOpen()) {
      this.log("warn", "command", `dropped ${cmd.type} — socket not open`);
      throw new Error(`streamer socket not open (${cmd.type})`);
    }
    if (
      DeviceManager.WAKE_COMMANDS.has(cmd.type) &&
      this.cache.systemPower != null &&
      this.cache.systemPower.power !== "ON"
    ) {
      await this.ensureAwake(this.askedBy(cmd));
      // The wake takes seconds, and the connection can drop and reconnect across it (or another
      // streamer be chosen meanwhile): the command waits a moment for this manager's socket to be
      // open again, else it fails loudly like any other, never into a closed socket (0.12.0-rc.2,
      // the 0.11 re-score; S127)
      if (!(await this.socketBack(socket))) {
        this.log("warn", "command", `dropped ${cmd.type} — socket not open after the wake`);
        throw new Error(`streamer socket not open after the wake (${cmd.type})`);
      }
    }

    // PASSIVE-ONLY firmware policy (explicit user decision): there is NO command
    // that sends /system/update with an `action` param. TastyTunes only ever
    // SUBSCRIBES to /system/update (read-only, see smoipSocket SUBSCRIBED_PATHS)
    // to SHOW whether an update is available; it never sends action=CHECK
    // (refresh availability) or action=UPDATE (install). Updating the streamer's
    // firmware stays the user's job via the Cambridge Audio app or the
    // streamer's own web admin. Do not add a firmware check/install command here.
    const frames = commandFrames(cmd, {
      nowPlaying: this.cache.nowPlaying,
      playState: this.cache.playState,
      zoneState: this.cache.zoneState,
      systemPower: this.cache.systemPower,
      audioSpec: this.cache.audioSpec,
      powerSpec: this.cache.powerSpec,
      volumeLimitPercent: getSettings().volumeLimitPercent,
    });
    if (frames) {
      for (const f of frames) socket.send(f.path, f.params);
      return;
    }
    // what is not a plain socket write (commandFrames answers null for these)
    switch (cmd.type) {
      case "resumeHeld":
        return this.resumeHeld(socket);
      case "recallPreset": {
        this.setRecalledPreset(cmd.presetId);
        listeningRecord.openContext({
          kind: "preset",
          id: cmd.presetId,
          name: this.cache.presets?.presets?.find((p) => p.id === cmd.presetId)?.name ?? null,
          streamer: this.cache.systemInfo?.udn ?? null,
        });
        socket.send("/zone/recall_preset", { preset: cmd.presetId });
        // Feature 10: the preset's local volume override rides along on every
        // recall through the app — after a beat for the source switch — unless
        // the caller (a schedule with its own volume) opts out.
        if (!cmd.skipVolume) {
          const level =
            getSettings().presetVolumes[presetVolumeKey(this.cache.systemInfo?.udn, cmd.presetId)];
          if (level != null) {
            // the streamer may have changed in the second since, and a timer armed
            // for one device never acts on another
            setTimeout(() => {
              if (this.socket === socket) this.fire({ type: "setVolumePercent", percent: level });
            }, 1200);
          }
        }
        // The device updates is_playing internally but doesn't reliably push
        // /presets/list (vibin's observation, esp. for UPnP presets). Refetch
        // once quickly (radio) and once late (album recalls switch source and
        // load a queue first); source- and queue-change refetches fire between.
        for (const delay of [800, 2800]) {
          setTimeout(() => void this.refreshPresets(socket), delay);
        }
        return;
      }
      case "queueDelete":
        return smoipHttp.queueDelete(host, cmd.id);
      case "queueClear":
        listeningRecord.endContext();
        return smoipHttp.queueClear(host);
      case "queueMove":
        return smoipHttp.queueMove(host, cmd.id, cmd.from, cmd.to);
      case "presetDelete":
        await smoipHttp.presetDelete(host, cmd.presetId);
        return this.refreshPresets(socket);
      case "presetRename":
        await smoipHttp.presetRename(host, cmd.slot, cmd.name);
        return this.refreshPresets(socket);
      case "queueSavePreset":
        await smoipHttp.queueSavePreset(host, cmd.slot, cmd.name);
        return this.refreshPresets(socket);
      case "streamRadio":
        return smoipHttp.streamRadio(host, cmd.url, cmd.name);
      case "zoneSavePreset":
        await smoipHttp.zoneSavePreset(host, cmd.slot);
        return this.refreshPresets(socket);
      case "presetMove":
        await smoipHttp.presetMove(host, cmd.from, cmd.to);
        return this.refreshPresets(socket);
    }
  }

  /**
   * Called when the volume limit setting changes: if the streamer is currently
   * louder than the new limit, pull it down to the limit right away.
   */
  enforceVolumeLimit(): void {
    const limit = getSettings().volumeLimitPercent;
    const current = this.cache.zoneState?.volume_percent;
    if (limit != null && current != null && current > limit) {
      this.fire({ type: "setVolumePercent", percent: limit });
    }
  }

  /**
   * Probe /zone/audio/spec after connect: the tone-controls capability
   * document. Every non-positive outcome (404, timeout, junk) lands as null =
   * "this streamer has no tone controls" and the UI section stays hidden.
   */
  private async probeAudioSpec(socket: SmoipSocket): Promise<void> {
    const spec = (await smoipHttp.getAudioSpec(socket.host)) as ZoneAudioSpec | null;
    if (this.socket !== socket) return;
    this.cache.audioSpec = spec;
    this.push({ kind: "audioSpec", data: spec });
    if (spec) this.log("info", "audio", "tone/EQ spec present — controls enabled where writable");
  }

  /**
   * Probe /system/display/spec + /system/power/spec after connect — the §10
   * brightness/standby capability docs. Every non-positive outcome lands as
   * null (headless unit, timeout) and the matching control stays hidden.
   */
  private async probeSystemSpecs(socket: SmoipSocket): Promise<void> {
    const [display, power] = await Promise.all([
      smoipHttp.getDisplaySpec(socket.host) as Promise<SystemDisplaySpec | null>,
      smoipHttp.getPowerSpec(socket.host) as Promise<SystemPowerSpec | null>,
    ]);
    if (this.socket !== socket) return;
    this.cache.displaySpec = display;
    this.cache.powerSpec = power;
    this.push({ kind: "displaySpec", data: display });
    this.push({ kind: "powerSpec", data: power });
  }

  // ------------------------------------------------------------ incoming frames

  private handleFrame(frame: SmoipFrame): void {
    this.recordFrame("in", frame);
    const data = frame.params?.data;
    if (data === undefined) return;

    switch (frame.path) {
      case "/zone/play_state":
        this.cache.playState = data as ZonePlayState;
        this.trackNotifier.note(this.cache.playState);
        this.collections.recordRecentlyPlayed(this.cache.playState, {
          nowPlaying: this.cache.nowPlaying ?? null,
          streamer: this.cache.systemInfo?.udn ?? null,
        });
        this.sleeper.boundaryCheck(this.cache.playState);
        scrobbler.onPlayState(this.cache.playState);
        listeningRecord.onPlayState(
          this.cache.playState,
          this.cache.nowPlaying?.source?.name ?? this.cache.playState.metadata?.source ?? null,
          this.cache.systemInfo?.udn ?? null,
        );
        this.noteHeld();
        return this.push({ kind: "playState", data: this.cache.playState });
      case "/zone/play_state/position":
        this.cache.position = data as ZonePosition;
        this.noteHeld();
        return this.push({ kind: "position", data: this.cache.position });
      case "/zone/now_playing":
        this.cache.nowPlaying = data as ZoneNowPlaying;
        this.sourceChanged((data as ZoneNowPlaying).source?.id);
        this.noteHeld();
        return this.push({ kind: "nowPlaying", data: this.cache.nowPlaying });
      case "/zone/state":
        this.cache.zoneState = data as ZoneState;
        this.sourceChanged((data as ZoneState).source);
        this.noteHeld();
        return this.push({ kind: "zoneState", data: this.cache.zoneState });
      case "/queue/list":
        this.cache.queue = data as QueueList;
        listeningRecord.onQueue(
          (this.cache.queue.items ?? []).map((i) => i.id).filter((id): id is number => id != null),
        );
        // Mid-batch (playlist activation) the cache stays current but the
        // renderer hears nothing — one authoritative push lands at the end.
        if (this.queueOps.batching) return;
        return this.push({ kind: "queue", data: this.cache.queue });
      case "/presets/list":
        this.cache.presets = data as Presets;
        return this.push({ kind: "presets", data: this.cache.presets });
      case "/system/info": {
        this.cache.systemInfo = data as SystemInfo;
        // The device book learns a streamer HERE — a successful connection
        // that told us its identity — never from a mere sweep sighting of a
        // stranger (refreshKnownFromSweep only updates devices already known).
        const info = this.cache.systemInfo;
        // Never the demo: its loopback port is as ephemeral as its lastHost.
        if (info.udn && this.socket && !this.demo) {
          this.rememberDevice({
            udn: info.udn,
            host: this.socket.host,
            friendlyName: info.name ?? info.model ?? this.socket.host,
            model: info.model ?? "",
          });
        }
        // the streamer is known: what it held when it last slept (the standby face's offer)
        this.push({ kind: "held", held: heldFor(info.udn ?? null) });
        return this.push({ kind: "systemInfo", data: this.cache.systemInfo });
      }
      case "/system/power": {
        const prev = this.cache.systemPower?.power;
        this.cache.systemPower = data as SystemPower;
        // Waking from standby: re-request the queue — it may have CHANGED
        // shape across the cycle (live-probed 2026-07-23: server queues
        // survive standby, USB queues are dropped; USB remount also lags,
        // hence the second, late refetch).
        if (prev != null && prev !== "ON" && this.cache.systemPower.power === "ON") {
          for (const delay of [2500, 10000]) {
            setTimeout(() => this.socket?.isOpen() && this.socket.send("/queue/list"), delay);
          }
        }
        // going to sleep: what it was doing, with the latest position, is the offer
        if (prev === "ON" && this.cache.systemPower.power !== "ON") this.holdAtStandby();
        return this.push({ kind: "systemPower", data: this.cache.systemPower });
      }
      case "/system/update": {
        // Read-only firmware self-check the streamer pushes to subscribers.
        // Camelcase the wire shape into the clean FirmwareStatus the UI reads.
        // We NEVER act on this — see the PASSIVE-ONLY guard in command().
        const u = data as SystemUpdate;
        this.cache.firmwareUpdate = {
          updateAvailable: u.update_available === true,
          updating: u.updating === true,
          earlyUpdate: u.early_update === true,
        };
        return this.push({ kind: "firmwareUpdate", data: this.cache.firmwareUpdate });
      }
      case "/system/sources":
        this.cache.sources = data as SystemSources;
        return this.push({ kind: "sources", data: this.cache.sources });
      case "/zone/audio":
        // Pushed on every tone/EQ change, ours or another controller's
        // (confirmed live 2026-07-19) — the UI mirrors external tweaks free.
        this.cache.zoneAudio = data as ZoneAudio;
        return this.push({ kind: "zoneAudio", data: this.cache.zoneAudio });
      case "/system/display":
        this.cache.systemDisplay = data as SystemDisplay;
        return this.push({ kind: "systemDisplay", data: this.cache.systemDisplay });
      case "/queue/info": {
        // The socket already refetches /queue/list. A queue change is also the
        // only observable signal of an album->album preset recall (same source,
        // no /presets/list push) — refresh presets too, debounced.
        if (this.queuePresetsTimer) clearTimeout(this.queuePresetsTimer);
        const socket = this.socket;
        this.queuePresetsTimer = setTimeout(() => {
          this.queuePresetsTimer = null;
          void this.refreshPresets(socket);
        }, 1000);
        return;
      }
      default:
        // Command echoes (/zone/play_control etc.) are visible in the frame log.
        return;
    }
  }

  /**
   * Fetch fresh presets over HTTP and push them — vibin's approach. The device
   * doesn't push /presets/list for local-media (UPnP) recalls, and a bare WS
   * request for it isn't proven against real hardware; HTTP GET is.
   */
  private async refreshPresets(socket: SmoipSocket | null): Promise<void> {
    if (!socket || this.socket !== socket) return;
    try {
      const data = await smoipHttp.getPresets(socket.host);
      if (data == null || this.socket !== socket) return;
      this.cache.presets = data as Presets;
      this.push({ kind: "presets", data: this.cache.presets });
    } catch (err) {
      this.log("warn", "presets", `refresh failed: ${(err as Error).message}`);
    }
  }

  /**
   * Refetch presets whenever the active audio source changes — vibin's trick.
   * The device updates preset is_playing flags internally on recall but only
   * pushes /presets/list for radio presets; an album (UPnP) recall announces
   * itself as a source switch to MEDIA_PLAYER instead. The first source report
   * after connect is initial state, not a change.
   */
  private sourceChanged(sourceId: string | null | undefined): void {
    if (!sourceId || sourceId === this.lastSourceId) return;
    const isInitial = this.lastSourceId === null;
    this.lastSourceId = sourceId;
    if (isInitial) return;
    const socket = this.socket;
    setTimeout(() => void this.refreshPresets(socket), 500);
  }

  /** The OS notification for a track change while the app is unfocused; see trackNotifier.ts. */
  private readonly trackNotifier = new TrackNotifier();

  // ------------------------------------------------------------------ MCP status

  /** Status pushed by the MCP bridge (null = log only, keep current status). */
  setMediaIndex(statuses: MediaIndexStatus[]): void {
    this.mediaIndexStatuses = statuses;
    this.push({ kind: "mediaIndex", statuses });
  }

  /**
   * A wake schedule missed while the machine slept, mirrored to the renderer so
   * the Schedules tab can offer it too. The OS notification is the loud
   * surface; this is the one that survives Do Not Disturb. Owned here, like
   * mcpStatus, so it rides the snapshot and a fresh window sees it.
   */
  setMissedSchedule(missed: MissedSchedule | null): void {
    this.missedSchedule = missed;
    this.push({ kind: "scheduleMissed", missed });
  }

  setMcpStatus(status: McpStatus | null, logText: string, level: LogEntry["level"] = "info"): void {
    this.log(level, "mcp", logText);
    if (status) {
      this.mcpStatus = status;
      this.push({ kind: "mcpStatus", status });
    }
  }

  // ------------------------------------------------------------------ collections

  /** The recently played log, favorites and playlists: each write pushes its list to every
   *  window (see collections.ts). */
  readonly collections = new Collections((msg) => this.push(msg));

  /**
   * The queue-writing engine (playlist activation, queue undo, content
   * resolve). ONE instance, owned here; the invariants that make batched queue
   * writes safe travel with it — see queueOps.ts. The methods below delegate so
   * the IPC surface and mcpServer see no change.
   *
   * The closures read live state rather than copying it: `socket` and the
   * cached queue both move under a run as frames arrive.
   */
  private readonly queueOps = new QueueOps({
    host: () => (this.connection.phase === "connected" ? this.connection.host : null),
    socket: () => this.socket,
    queue: () => this.cache.queue ?? null,
    push: (msg) => this.push(msg),
    ensureAwake: () => this.ensureAwake(),
  });

  /** Live activation state, for the boot snapshot. */
  get playlistActivation(): PlaylistActivation | null {
    return this.queueOps.activation;
  }

  cancelPlaylistActivation(): void {
    this.queueOps.cancelActivation();
  }

  /** See QueueOps.playlistActivate — one run at a time, batched, self-healing. */
  async playlistActivate(id: string): Promise<PlaylistActivation> {
    return this.queueOps.playlistActivate(id);
  }

  /** See QueueOps.queueRestore — the undo behind the queue's ×. */
  async queueRestore(ref: ContentRef, position: number): Promise<QueueRestoreResult> {
    return this.queueOps.queueRestore(ref, position);
  }

  /** See QueueOps.contentResolve — index-first resolution of a track known
   *  only by its content. */
  async contentResolve(ref: ContentRef): Promise<ResolvedContent | null> {
    return this.queueOps.contentResolve(ref);
  }

  // ----------------------------------------------------------------- push relay

  /**
   * A main-process listener on the same push stream the windows get — for
   * surfaces that aren't a renderer. The tray's native menu is a snapshot the
   * OS owns, so it has to be rebuilt when the device moves; without this it
   * would sit there describing a streamer that has since gone to standby.
   */
  onPush: ((msg: PushMessage) => void) | null = null;

  private push(msg: PushMessage): void {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send("tt:push", msg);
    }
    this.onPush?.(msg);
  }

  private setRecalledPreset(id: number | null): void {
    if (id === this.lastRecalledPresetId) return;
    this.lastRecalledPresetId = id;
    this.push({ kind: "recalledPreset", id });
  }

  private setConnection(state: ConnectionState): void {
    if (state.phase !== "idle" && this.demo) state.demo = true;
    this.connection = state;
    this.ensureRediscover();
    // Wallclock-based listen accounting can't survive a dead link or a device
    // switch — drop the in-flight track rather than over-count it.
    if (state.phase !== "connected") {
      scrobbler.reset();
      // Close out the open play so its accumulated time reaches the record —
      // a disconnect or device switch must not lose the last track.
      listeningRecord.flush();
    }
    this.push({ kind: "connection", state });
  }

  private pushDevices(): void {
    this.push({ kind: "devices", devices: this.devices, discovering: this.discovering });
  }

  /**
   * The windows whose diagnostics drawer is open. A frame goes only to them: every frame
   * used to reach every window (the main window, the mini player, the tray panel), each of
   * which copied its ring on every one, the position tick once a second among them, for a
   * drawer that is closed nearly always (0.11.0 sweep). The ring itself is always kept, and
   * a drawer opening is answered with it (watchFrames).
   */
  private readonly frameWatchers = new Set<WebContents>();

  /** A window's drawer opened or closed; answers the ring so far. */
  watchFrames(wc: WebContents, on: boolean): FrameEntry[] {
    if (!on) this.frameWatchers.delete(wc);
    else if (!this.frameWatchers.has(wc)) {
      this.frameWatchers.add(wc);
      wc.once("destroyed", () => this.frameWatchers.delete(wc));
    }
    return this.frames;
  }

  private recordFrame(dir: "in" | "out", frame: SmoipFrame): void {
    const entry: FrameEntry = { at: Date.now(), dir, frame };
    this.frames.push(entry);
    if (this.frames.length > FRAME_RING_SIZE) this.frames.shift();
    const msg: PushMessage = { kind: "frame", entry };
    for (const wc of this.frameWatchers) if (!wc.isDestroyed()) wc.send("tt:push", msg);
  }

  /** A line in the diagnostics log (the ring the Device screen shows, and the console); public
   *  since the URL scheme, whose verbs report there too (app/urlActions). */
  log(level: LogEntry["level"], scope: string, text: string): void {
    const entry: LogEntry = { at: Date.now(), level, scope, text };
    this.logs.push(entry);
    if (this.logs.length > LOG_RING_SIZE) this.logs.shift();
    this.push({ kind: "log", entry });
    console.log(`[${scope}] ${text}`);
  }

  // ------------------------------------------------------------------- snapshot

  snapshot(): Snapshot {
    return {
      connection: this.connection,
      devices: this.devices,
      discovering: this.discovering,
      settings: getSettings(),
      ...this.cache,
      sleep: this.sleeper.current,
      lastRecalledPresetId: this.lastRecalledPresetId,
      // the snapshot carries the captured pictures too (a capture that landed
      // before the window existed would otherwise show the dead URL)
      recents: decorateRecents(getRecents()),
      favorites: getFavorites(),
      playlists: getPlaylists(),
      playlistActivation: this.queueOps.activation,
      held: heldFor(this.cache.systemInfo?.udn ?? null),
      missedSchedule: this.missedSchedule,
      mcpStatus: this.mcpStatus,
      mediaIndex: this.mediaIndexStatuses,
      frames: this.frames,
      logs: this.logs,
      netRequests: getNetRequests(),
    };
  }
}
