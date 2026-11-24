import { describe, expect, it } from "vitest";
import { litPresetIds, type LitInput } from "./litPresets";
import type { PresetItem, ZonePlayState } from "./smoip";

const radio = (id: number, rid: number): PresetItem =>
  ({
    id,
    name: `Station ${id}`,
    type: "Radio",
    class: "stream.radio",
    airable_radio_id: rid,
    is_playing: false,
  }) as PresetItem;
const album = (id: number, name: string, art: string): PresetItem =>
  ({
    id,
    name,
    type: "UPnP",
    class: "stream.media.upnp",
    art_url: art,
    is_playing: false,
  }) as PresetItem;

const base = (
  playState: Partial<ZonePlayState> | null,
  more: Partial<LitInput> = {},
): LitInput => ({
  zoneState: null,
  nowPlaying: null,
  playState: playState as ZonePlayState | null,
  queue: null,
  systemInfo: null,
  systemPower: { power: "ON" },
  waking: false,
  lastRecalledPresetId: null,
  deadPresets: [],
  queueSignatures: {},
  ...more,
});

describe("which presets are playing (one rule, the window's and another screen's)", () => {
  const items = [radio(1, 100), radio(2, 200), album(3, "Amber Nights", "http://nas/a.jpg")];

  it("lights a station by its radio id, and an album by its picture", () => {
    expect([...litPresetIds(items, base({ metadata: { radio_id: 200 } as never }))]).toEqual([2]);
    expect([
      ...litPresetIds(
        items,
        base({ metadata: { art_url: "http://nas/a.jpg?x=1", album: "Other" } as never }),
      ),
    ]).toEqual([3]);
  });

  it("lights nothing while the streamer sleeps or wakes", () => {
    const ps = { metadata: { radio_id: 200 } as never };
    expect(litPresetIds(items, base(ps, { systemPower: { power: "NETWORK" } })).size).toBe(0);
    expect(litPresetIds(items, base(ps, { waking: true })).size).toBe(0);
  });

  it("never lights a preset whose recall came to nothing", () => {
    expect(
      litPresetIds(items, base({ metadata: { radio_id: 200 } as never }, { deadPresets: [2] }))
        .size,
    ).toBe(0);
  });

  it("lights the app's own last recall while what plays still matches it", () => {
    const twin = [radio(1, 100), radio(4, 100)];
    expect([
      ...litPresetIds(
        twin,
        base({ metadata: { radio_id: 100 } as never }, { lastRecalledPresetId: 4 }),
      ),
    ]).toEqual([4]);
  });
});
