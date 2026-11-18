import { describe, expect, it, vi } from "vitest";
import type { StreamerCommand } from "@shared/ipc";
import { type CommandConnection, FADE_TAKEOVER, openAgain, sendCommand } from "./commandPath";
import type { SmoipSocket } from "./smoipSocket";
import { emptyCache, type PresetVolumeAfterRecall, type StreamerCache } from "./streamerCache";
import type { VolumeFader } from "./volumeFader";

/** A connection of fakes: a socket that records what it sends, a fader that may be mid-fade. */
function connection(
  opts: {
    open?: boolean;
    socket?: boolean;
    asleep?: boolean;
    fading?: boolean;
    back?: boolean;
    quiet?: boolean;
  } = {},
) {
  const sent: Array<{ path: string; params: unknown }> = [];
  let open = opts.open ?? true;
  const socket = {
    host: "streamer.local",
    isOpen: () => open,
    send: (path: string, params: unknown) => sent.push({ path, params }),
  } as unknown as SmoipSocket;
  const cache: StreamerCache = emptyCache();
  cache.systemPower = { power: opts.asleep ? "NETWORK" : "ON" };
  const fader = { interruptible: opts.fading ?? false, cancelFade: vi.fn() };
  const presetLevel = { onCommand: vi.fn() };
  const refusals: string[] = [];
  const conn: CommandConnection = {
    cache: () => cache,
    socket: () => (opts.socket === false ? null : socket),
    fader: fader as unknown as VolumeFader,
    presetLevel: presetLevel as unknown as PresetVolumeAfterRecall,
    ensureAwake: vi.fn(() => {
      cache.systemPower = { power: "ON" };
      return Promise.resolve();
    }),
    socketBack: vi.fn(() => Promise.resolve(opts.back ?? true)),
    refuse: (cmd, why) => {
      refusals.push(`${cmd.type}: ${why}`);
      return opts.quiet ? null : new Error(why);
    },
  };
  return { conn, sent, fader, presetLevel, refusals, socket, close: () => (open = false) };
}

const volume: StreamerCommand = { type: "setVolumePercent", percent: 30 };
const recall: StreamerCommand = { type: "recallPreset", presetId: 3 };

describe("one command path for every connection", () => {
  it("a volume, power or transport command takes over from a running fade; the fade's own write and other verbs don't", async () => {
    const mid = connection({ fading: true });
    await sendCommand(mid.conn, volume);
    expect(mid.fader.cancelFade).toHaveBeenCalledWith(false);
    const own = connection({ fading: false });
    await sendCommand(own.conn, volume);
    expect(own.fader.cancelFade).not.toHaveBeenCalled();
    const other = connection({ fading: true });
    await sendCommand(other.conn, recall);
    expect(other.fader.cancelFade).not.toHaveBeenCalled();
    expect([...FADE_TAKEOVER]).toEqual(
      expect.arrayContaining(["setVolumePercent", "power", "pause", "play", "togglePlayback"]),
    );
  });

  it("a plain write goes out as its frames, under the volume limit's rule, and is done", async () => {
    const c = connection();
    expect(await sendCommand(c.conn, volume)).toBeNull();
    expect(c.sent).toEqual([{ path: "/zone/state", params: { volume_percent: 30 } }]);
    expect(c.presetLevel.onCommand).toHaveBeenCalledWith("setVolumePercent");
  });

  it("a verb that isn't a plain write comes back to the connection with its open socket", async () => {
    const c = connection();
    expect(await sendCommand(c.conn, recall)).toBe(c.socket);
    expect(c.sent).toEqual([]);
  });

  it("no connection, or a socket that isn't open, is refused in the connection's words, quietly where it says so", async () => {
    const none = connection({ socket: false, quiet: true });
    expect(await sendCommand(none.conn, volume)).toBeNull();
    expect(none.refusals).toEqual(["setVolumePercent: no connection"]);
    const closed = connection({ open: false });
    await expect(sendCommand(closed.conn, volume)).rejects.toThrow("not open");
    expect(closed.sent).toEqual([]);
  });

  it("a play-shaped command wakes a sleeping streamer first, and never writes into a socket that didn't come back", async () => {
    const back = connection({ asleep: true, back: true });
    await sendCommand(back.conn, { type: "play" });
    expect(back.conn.ensureAwake).toHaveBeenCalled();
    expect(back.sent.map((f) => f.path)).toEqual(["/zone/play_control"]);
    const gone = connection({ asleep: true, back: false });
    await expect(sendCommand(gone.conn, recall)).rejects.toThrow("not open after the wake");
    expect(gone.sent).toEqual([]);
    const awake = connection();
    await sendCommand(awake.conn, { type: "play" });
    expect(awake.conn.ensureAwake).not.toHaveBeenCalled();
  });

  it("openAgain waits for the socket, and gives up once another has taken its place", async () => {
    const c = connection({ open: false });
    let open = false;
    const socket = { isOpen: () => open } as unknown as SmoipSocket;
    setTimeout(() => (open = true), 250);
    expect(await openAgain(socket, () => true, 2000)).toBe(true);
    expect(await openAgain(c.socket, () => false, 2000)).toBe(false);
  });
});
