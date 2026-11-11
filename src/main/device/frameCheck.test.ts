import { describe, expect, it } from "vitest";
import { checkFrame } from "./frameCheck";

// the Evo's own shapes (trimmed captures), the ones that must pass exactly as they came
const PLAY_STATE = {
  state: "play",
  position: 63,
  presettable: true,
  queue_index: 2,
  queue_length: 10,
  queue_id: 1003,
  mode_repeat: "off",
  mode_shuffle: "off",
  metadata: {
    class: "md.track",
    source: "MEDIA_PLAYER",
    title: "Next To Me",
    artist: "RÜFÜS DU SOL",
    album: "Surrender",
    duration: 241,
    lossless: true,
    sample_rate: 44100,
    bit_depth: 16,
    an_extra_field: { the: "firmware's own" },
  },
};

const NOW_PLAYING = {
  state: "PLAYING",
  source: { id: "MEDIA_PLAYER", name: "Media Player" },
  display: { line1: "Next To Me", progress: { position: 63, duration: 241 } },
  queue: { length: 10, position: 2 },
  controls: ["play_pause", "track_next"],
};

describe("checkFrame", () => {
  it("passes a frame that matches its type exactly as it came, extra fields and all", () => {
    for (const [path, data] of [
      ["/zone/play_state", PLAY_STATE],
      ["/zone/now_playing", NOW_PLAYING],
      ["/zone/play_state/position", { position: 64 }],
      ["/system/power", { power: "ON", standby_mode: "NETWORK" }],
      ["/system/sources", { sources: [{ id: "AIRPLAY", name: "AirPlay", ui_selectable: true }] }],
    ] as const) {
      const r = checkFrame(path, data);
      expect(r).toEqual({ ok: true, data, setAside: [] });
    }
  });

  it("leaves a missing field missing", () => {
    const r = checkFrame("/zone/state", { volume_percent: 30 });
    expect(r).toEqual({ ok: true, data: { volume_percent: 30 }, setAside: [] });
  });

  it("drops a frame whose data isn't an object, naming what it was", () => {
    expect(checkFrame("/zone/play_state", null)).toEqual({
      ok: false,
      reason: "its data was null",
    });
    expect(checkFrame("/zone/now_playing", [1, 2])).toEqual({
      ok: false,
      reason: "its data was a list",
    });
    expect(checkFrame("/queue/list", "soon")).toEqual({
      ok: false,
      reason: "its data was a string",
    });
  });

  it("sets aside a field of the wrong kind as null and names it, keeping the rest", () => {
    const r = checkFrame("/zone/now_playing", { ...NOW_PLAYING, source: 5, controls: "play" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ source: null, controls: null, display: NOW_PLAYING.display });
    expect(r.setAside).toEqual(["source was a number", "controls was a string"]);
  });

  it("sets aside a nested field by its full name", () => {
    const r = checkFrame("/zone/play_state", {
      ...PLAY_STATE,
      metadata: { ...PLAY_STATE.metadata, title: 7, duration: "four minutes" },
    });
    expect(r.ok && r.setAside).toEqual([
      "metadata.duration was a string",
      "metadata.title was a number",
    ]);
    expect(r.ok && (r.data as typeof PLAY_STATE).metadata.album).toBe("Surrender");
  });

  it("leaves out a list entry of the wrong kind and names it", () => {
    const r = checkFrame("/queue/list", {
      total: 3,
      items: [{ id: 1, metadata: { title: "a" } }, null, { id: 3, metadata: { title: "c" } }],
    });
    expect(r.ok && (r.data as { items: unknown[] }).items).toHaveLength(2);
    expect(r.ok && r.setAside).toEqual(["items[1] was null, left out"]);
    const notAList = checkFrame("/queue/list", { total: 3, items: "oops" });
    expect(notAList.ok && notAList.setAside).toEqual(["items was a string"]);
  });

  it("drops a frame missing what its readers can't do without", () => {
    expect(checkFrame("/zone/play_state/position", { position: "soon" }).ok).toBe(false);
    expect(checkFrame("/system/power", { standby_mode: "ECO_MODE" }).ok).toBe(false);
    expect(checkFrame("/system/display", { brightness: 2 }).ok).toBe(false);
    const sources = checkFrame("/system/sources", {
      sources: [{ id: "TV", name: "TV" }, { name: "no id" }],
    });
    expect(sources.ok && (sources.data as { sources: unknown[] }).sources).toEqual([
      { id: "TV", name: "TV" },
    ]);
  });

  it("reads tone and EQ whole or not at all", () => {
    const r = checkFrame("/zone/audio", {
      balance: 0,
      user_eq: {
        enabled: true,
        bands: [{ index: 0, filter: "LOWSHELF", freq: 80, gain: "+2", q: 0.7 }],
      },
    });
    expect(r.ok && (r.data as { user_eq: unknown }).user_eq).toBeNull();
    expect(r.ok && r.setAside).toEqual(["user_eq was an object"]);
  });

  it("passes a path it has no check for as it came", () => {
    expect(checkFrame("/zone/play_control", null)).toEqual({ ok: true, data: null, setAside: [] });
  });
});
