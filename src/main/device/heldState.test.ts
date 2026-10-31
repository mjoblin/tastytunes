import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { describe, expect, it } from "vitest";
import type { HeldState } from "@shared/model";
import type {
  Source,
  ZonePlayState,
  ZonePlayStateMetadata,
  ZonePlayStateState,
} from "@shared/smoip";
import { heldFor, heldFrom, saveHeld, type HeldInput } from "./heldState";

// the shapes the Evo sent on 2026-10-06
const source = (id: string, name: string, cls: string): Source => ({
  id,
  name,
  default_name: name,
  class: cls,
  nameable: false,
  ui_selectable: true,
  description: name,
  description_locale: name,
  preferred_order: 0,
});
const sources = {
  sources: [
    source("MEDIA_PLAYER", "Media Library", "stream.media"),
    source("IR", "Internet Radio", "stream.radio"),
    source("AIRPLAY", "AirPlay", "stream.airplay"),
    source("SPDIF_TOSLINK", "Optical 1", "digital.toslink"),
  ],
};
const metadata = (over: Partial<ZonePlayStateMetadata>): ZonePlayStateMetadata => ({
  class: null,
  source: null,
  name: null,
  playback_source: null,
  track_number: null,
  duration: null,
  album: null,
  artist: null,
  title: null,
  art_url: null,
  sample_format: null,
  mqa: null,
  codec: null,
  lossless: null,
  sample_rate: null,
  bit_depth: null,
  encoding: null,
  station: null,
  bitrate: null,
  radio_id: null,
  ...over,
});
const playState = (
  state: ZonePlayStateState,
  over: Omit<Partial<ZonePlayState>, "metadata"> & {
    metadata?: Partial<ZonePlayStateMetadata> | null;
  } = {},
): ZonePlayState => ({
  state,
  position: null,
  presettable: null,
  queue_index: null,
  queue_length: null,
  queue_id: null,
  mode_repeat: null,
  mode_shuffle: null,
  ...over,
  metadata: over.metadata ? metadata(over.metadata) : null,
});
const input = (sourceId: string, ps: ZonePlayState, extra: Partial<HeldInput> = {}): HeldInput => ({
  streamer: "evo",
  power: "ON",
  playState: ps,
  nowPlaying: null,
  zoneState: {
    source: sourceId,
    power: null,
    pre_amp_mode: null,
    pre_amp_state: null,
    mute: null,
    volume_step: null,
    volume_percent: null,
    volume_db: null,
    cbus: null,
  },
  sources,
  position: null,
  via: null,
  now: 5,
  ...extra,
});
const at = (sourceId: string, ps: ZonePlayState, extra: Partial<HeldInput> = {}) =>
  heldFrom(input(sourceId, ps, extra));

const preset = { kind: "preset", id: 3, name: "Hopes And Fears", streamer: "evo" } as const;
const queueTrack = (): HeldState | null =>
  at(
    "MEDIA_PLAYER",
    playState("play", {
      queue_id: 4646736,
      position: 50,
      metadata: {
        class: "md.track.library",
        title: "Somewhere Only We Know",
        artist: "Keane",
        album: "Hopes And Fears",
        duration: 235,
      },
    }),
    { position: 57, via: preset },
  );
const optical = (): HeldState | null =>
  at("SPDIF_TOSLINK", playState("no_signal", { metadata: { class: "md.input" } }));

describe("heldFrom", () => {
  it("holds a queue track's entry, the playhead's position and the preset it came from", () => {
    const q = queueTrack();
    expect(q?.kind).toBe("queue");
    expect(q?.queueId).toBe(4646736);
    expect(q?.position).toBe(57);
    expect(q?.duration).toBe(235);
    expect(q?.via?.name).toBe("Hopes And Fears");
    expect(q?.sourceId).toBe("MEDIA_PLAYER");
  });

  it("holds a station by its name, AirPlay as a service with or without a track, and Optical 1 as an input", () => {
    const radio = at(
      "IR",
      playState("play", { metadata: { class: "md.radio", station: "Radio Paradise" } }),
    );
    const airplay = at(
      "AIRPLAY",
      playState("play", {
        metadata: { class: "md.track", title: "Sun Has Set", artist: "Someone" },
      }),
    );
    const airplayIdle = at("AIRPLAY", playState("ready", { metadata: { class: "md.track" } }));
    const input = optical();
    expect(radio?.kind).toBe("radio");
    expect(radio?.title).toBe("Radio Paradise");
    expect(airplay?.kind).toBe("service");
    expect(airplay?.sourceName).toBe("AirPlay");
    expect(airplayIdle?.kind).toBe("service");
    expect(airplayIdle?.title).toBeNull();
    expect(input?.kind).toBe("input");
    expect(input?.sourceName).toBe("Optical 1");
  });

  it("holds nothing asleep, idle, not ready, for an empty library or for a radio with no station", () => {
    const none = [
      heldFrom(
        input("IDLE", playState("not_ready"), {
          power: "NETWORK",
        }),
      ),
      at("IDLE", playState("ready")),
      at("MEDIA_PLAYER", playState("not_ready")),
      at("MEDIA_PLAYER", playState("stop", { metadata: null })),
      at("IR", playState("ready", { metadata: { class: "md.radio" } })),
    ];
    expect(none).toEqual([null, null, null, null, null]);
  });
});

describe("saveHeld and heldFor", () => {
  it("saves a held state per streamer across restarts, and the demo's in memory only", () => {
    const q = queueTrack() as HeldState;
    const o = optical() as HeldState;
    saveHeld(q);
    saveHeld({ ...o, streamer: "demo" }, false);
    const file = JSON.parse(
      readFileSync(join(app.getPath("userData"), "held.json"), "utf8"),
    ) as Record<string, HeldState>;
    expect(file.evo?.queueId).toBe(4646736);
    expect(file.demo).toBeUndefined();
    expect(heldFor("demo")?.kind).toBe("input");
    expect(heldFor("evo")?.position).toBe(57);
  });
});
