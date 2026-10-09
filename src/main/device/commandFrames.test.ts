/**
 * The command translation's firmware rules: what each command sends over the
 * socket given what the device last said. Every case here was learned live on
 * a StreamMagic streamer; the comments in commandFrames.ts carry the dates.
 */
import { describe, expect, it } from "vitest";
import type { ZoneNowPlaying, ZonePlayState } from "@shared/smoip";
import { clampVolume, commandFrames, type CommandState } from "./commandFrames";

const idle: CommandState = {
  nowPlaying: null,
  playState: null,
  zoneState: null,
  systemPower: null,
  audioSpec: null,
  powerSpec: null,
  volumeLimitPercent: null,
};
const castSource = { controls: ["play_pause", "track_next"] } as unknown as ZoneNowPlaying;
const playing = { state: "play" } as ZonePlayState;
const paused = { state: "pause" } as ZonePlayState;

describe("play and pause on a source that offers only the toggle (AirPlay)", () => {
  it("play toggles from pause, and sends nothing while already playing", () => {
    const s = { ...idle, nowPlaying: castSource };
    expect(commandFrames({ type: "play" }, { ...s, playState: paused })).toEqual([
      { path: "/zone/play_control", params: { action: "toggle" } },
    ]);
    expect(commandFrames({ type: "play" }, { ...s, playState: playing })).toEqual([]);
  });

  it("pause toggles while playing, and never resumes a paused source", () => {
    const s = { ...idle, nowPlaying: castSource };
    expect(commandFrames({ type: "pause" }, { ...s, playState: playing })).toEqual([
      { path: "/zone/play_control", params: { action: "toggle" } },
    ]);
    expect(commandFrames({ type: "pause" }, { ...s, playState: paused })).toEqual([]);
  });

  it("a source offering the explicit verbs gets them", () => {
    const s = { ...idle, nowPlaying: { controls: ["play", "pause"] } as unknown as ZoneNowPlaying };
    expect(commandFrames({ type: "pause" }, s)).toEqual([
      { path: "/zone/play_control", params: { action: "pause" } },
    ]);
  });
});

describe("repeat one", () => {
  it("is all then one toggle, since one by name lands on all", () => {
    expect(commandFrames({ type: "setRepeat", mode: "one" }, idle)).toEqual([
      { path: "/zone/play_control", params: { mode_repeat: "all" } },
      { path: "/zone/play_control", params: { mode_repeat: "toggle" } },
    ]);
  });

  it("sends nothing when already on one, and off or all by name", () => {
    const s = { ...idle, playState: { mode_repeat: "one" } as ZonePlayState };
    expect(commandFrames({ type: "setRepeat", mode: "one" }, s)).toEqual([]);
    expect(commandFrames({ type: "setRepeat", mode: "off" }, s)).toEqual([
      { path: "/zone/play_control", params: { mode_repeat: "off" } },
    ]);
  });
});

describe("power", () => {
  it("never re-sends ON to a streamer that is on (it reboots)", () => {
    const on = { ...idle, systemPower: { power: "ON" } as CommandState["systemPower"] };
    expect(commandFrames({ type: "power", power: "ON" }, on)).toEqual([]);
    expect(commandFrames({ type: "power", power: "NETWORK" }, on)).toEqual([
      { path: "/system/power", params: { power: "NETWORK" } },
    ]);
  });
});

describe("volume", () => {
  it("clamps a write to the limit, to 0..100, whole", () => {
    expect(clampVolume(80, 60)).toBe(60);
    expect(clampVolume(-3, null)).toBe(0);
    expect(clampVolume(42.6, null)).toBe(43);
    expect(
      commandFrames({ type: "setVolumePercent", percent: 90 }, { ...idle, volumeLimitPercent: 70 }),
    ).toEqual([{ path: "/zone/state", params: { volume_percent: 70 } }]);
  });

  it("a step up at the limit sends nothing; a step down always goes", () => {
    const s = {
      ...idle,
      volumeLimitPercent: 50,
      zoneState: { volume_percent: 50 } as CommandState["zoneState"],
    };
    expect(commandFrames({ type: "volumeStepChange", delta: 1 }, s)).toEqual([]);
    expect(commandFrames({ type: "volumeStepChange", delta: -1 }, s)).toEqual([
      { path: "/zone/state", params: { volume_step_change: -1 } },
    ]);
  });
});

describe("tone and device controls", () => {
  it("EQ gains are written as gain-only band strings, clamped to the official envelope", () => {
    expect(commandFrames({ type: "setEqBands", gains: [9, -1.25] }, idle)).toEqual([
      { path: "/zone/audio", params: { zone: "ZONE1", user_eq_bands: "0,,,3.0,|1,,,-1.3," } },
    ]);
  });

  it("balance clamps to the spec's range, ±15 without one", () => {
    expect(commandFrames({ type: "setBalance", balance: 40 }, idle)).toEqual([
      { path: "/zone/audio", params: { zone: "ZONE1", balance: 15 } },
    ]);
    const spec = {
      ...idle,
      audioSpec: { balance: { minimum: -6, maximum: 6 } } as CommandState["audioSpec"],
    };
    expect(commandFrames({ type: "setBalance", balance: -9 }, spec)).toEqual([
      { path: "/zone/audio", params: { zone: "ZONE1", balance: -6 } },
    ]);
  });

  it("auto power down clamps to the spec's range when there is one", () => {
    const spec = {
      ...idle,
      powerSpec: { auto_power_down: { minimum: 0, maximum: 3600 } } as CommandState["powerSpec"],
    };
    expect(commandFrames({ type: "setAutoPowerDown", seconds: 7200 }, spec)).toEqual([
      { path: "/system/power", params: { auto_power_down: 3600 } },
    ]);
  });
});

describe("what is not a plain socket write", () => {
  it("is left to the device manager (null)", () => {
    expect(commandFrames({ type: "recallPreset", presetId: 3 }, idle)).toBeNull();
    expect(commandFrames({ type: "queueClear" }, idle)).toBeNull();
    expect(commandFrames({ type: "streamRadio", url: "http://x", name: "X" }, idle)).toBeNull();
    expect(commandFrames({ type: "resumeHeld" }, idle)).toBeNull();
  });
});
