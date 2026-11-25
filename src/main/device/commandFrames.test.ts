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

  it("a raise that would cross the limit stops at it; one below it stays a step change", () => {
    const at = (volume_percent: number): CommandState => ({
      ...idle,
      volumeLimitPercent: 40,
      zoneState: { volume_percent } as CommandState["zoneState"],
    });
    expect(commandFrames({ type: "volumeStepChange", delta: 20 }, at(39))).toEqual([
      { path: "/zone/state", params: { volume_percent: 40 } },
    ]);
    expect(commandFrames({ type: "volumeStepChange", delta: 5 }, at(36))).toEqual([
      { path: "/zone/state", params: { volume_percent: 40 } },
    ]);
    expect(commandFrames({ type: "volumeStepChange", delta: 5 }, at(30))).toEqual([
      { path: "/zone/state", params: { volume_step_change: 5 } },
    ]);
    // no limit: the step goes as sent
    expect(
      commandFrames(
        { type: "volumeStepChange", delta: 20 },
        { ...at(39), volumeLimitPercent: null },
      ),
    ).toEqual([{ path: "/zone/state", params: { volume_step_change: 20 } }]);
  });

  it("holds the limit on a model read in steps alone, by the same share of its scale", () => {
    // limit 50% on the 30-step scale is step 15
    const steps = (volume_step: number): CommandState => ({
      ...idle,
      volumeLimitPercent: 50,
      zoneState: { volume_step, volume_percent: null } as unknown as CommandState["zoneState"],
    });
    expect(commandFrames({ type: "setVolumeStep", step: 28 }, steps(10))).toEqual([
      { path: "/zone/state", params: { volume_step: 15 } },
    ]);
    expect(commandFrames({ type: "volumeStepChange", delta: 1 }, steps(15))).toEqual([]);
    expect(commandFrames({ type: "volumeStepChange", delta: 4 }, steps(13))).toEqual([
      { path: "/zone/state", params: { volume_step: 15 } },
    ]);
    expect(commandFrames({ type: "volumeStepChange", delta: 1 }, steps(10))).toEqual([
      { path: "/zone/state", params: { volume_step_change: 1 } },
    ]);
    expect(
      commandFrames(
        { type: "setVolumeStep", step: 28 },
        { ...steps(10), volumeLimitPercent: null },
      ),
    ).toEqual([{ path: "/zone/state", params: { volume_step: 28 } }]);
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

describe("a seek to a track's end (live 2026-11-25: the firmware drops one to the full length)", () => {
  const library = {
    controls: ["pause", "play_pause", "track_next", "track_previous", "seek"],
  } as unknown as ZoneNowPlaying;
  const at = (index: number, of: number, extra: Partial<ZonePlayState> = {}): CommandState => ({
    ...idle,
    nowPlaying: library,
    playState: {
      state: "play",
      queue_index: index,
      queue_length: of,
      mode_repeat: "off",
      metadata: { duration: 142 },
      ...extra,
    } as unknown as ZonePlayState,
  });
  const seek = (secs: number, s: CommandState) =>
    commandFrames({ type: "seek", positionSecs: secs }, s);

  it("lands a seek short of the last second where it was asked", () => {
    expect(seek(130, at(2, 12))).toEqual([
      { path: "/zone/play_control", params: { position: 130 } },
    ]);
    expect(seek(140.4, at(2, 12))).toEqual([
      { path: "/zone/play_control", params: { position: 140 } },
    ]);
  });

  it("goes to the next track for a seek into the last second, the full length included", () => {
    for (const secs of [141, 141.6, 142, 999])
      expect(seek(secs, at(2, 12))).toEqual([
        { path: "/zone/play_control", params: { skip_track: 1 } },
      ]);
  });

  it("with no track after it, lands two seconds short so the track ends on its own", () => {
    expect(seek(142, at(11, 12))).toEqual([
      { path: "/zone/play_control", params: { position: 140 } },
    ]);
    const noNext = {
      ...at(2, 12),
      nowPlaying: { controls: ["play_pause", "seek"] } as unknown as ZoneNowPlaying,
    };
    expect(seek(142, noNext)).toEqual([{ path: "/zone/play_control", params: { position: 140 } }]);
  });

  it("goes on past the queue's last track when the whole queue repeats", () => {
    expect(seek(142, at(11, 12, { mode_repeat: "all" }))).toEqual([
      { path: "/zone/play_control", params: { skip_track: 1 } },
    ]);
  });
});
