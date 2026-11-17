import { describe, expect, it } from "vitest";
import { presetVolumeHolds } from "@shared/model";
import {
  dropSlotFacts,
  healPresetVolumes,
  moveSlotFacts,
  renamedSlotFacts,
  slotsAfterMove,
} from "./presetSlots";

const U = "evo-1";
const OTHER = "evo-2";
const k = (slot: number, udn = U): string => `${udn}|${slot}`;
const list = (...names: Array<[number, string]>) => names.map(([id, name]) => ({ id, name }));

describe("a preset's level holds only for the preset it was set for", () => {
  it("holds when the names agree, or when none was kept", () => {
    expect(presetVolumeHolds({ [k(3)]: "Paper Moons" }, k(3), " paper moons")).toBe(true);
    expect(presetVolumeHolds({ [k(3)]: "Paper Moons" }, k(3), "Glass Orchard")).toBe(false);
    expect(presetVolumeHolds({ [k(3)]: "Paper Moons" }, k(3), null)).toBe(false);
    expect(presetVolumeHolds({}, k(3), "Glass Orchard")).toBe(true);
  });
});

describe("healPresetVolumes: the levels after a presets list", () => {
  it("adopts the slot's name for a level set before names were kept", () => {
    const out = healPresetVolumes(U, list([3, "Paper Moons"]), {
      presetVolumes: { [k(3)]: 40 },
      presetVolumeNames: {},
    });
    expect(out).toEqual({
      presetVolumes: { [k(3)]: 40 },
      presetVolumeNames: { [k(3)]: "Paper Moons" },
    });
  });

  it("moves a level to the slot its preset now sits in", () => {
    const out = healPresetVolumes(U, list([3, "Glass Orchard"], [7, "Paper Moons"]), {
      presetVolumes: { [k(3)]: 40 },
      presetVolumeNames: { [k(3)]: "Paper Moons" },
    });
    expect(out).toEqual({
      presetVolumes: { [k(7)]: 40 },
      presetVolumeNames: { [k(7)]: "Paper Moons" },
    });
  });

  it("drops a level whose preset no slot holds, and one for an empty slot", () => {
    const out = healPresetVolumes(U, list([3, "Glass Orchard"]), {
      presetVolumes: { [k(3)]: 40, [k(9)]: 55 },
      presetVolumeNames: { [k(3)]: "Paper Moons" },
    });
    expect(out).toEqual({ presetVolumes: {}, presetVolumeNames: {} });
  });

  it("never lets a moving level take a slot whose own preset has one", () => {
    // slot 7's own preset keeps its 25; slot 3's Paper Moons level has nowhere to go
    const out = healPresetVolumes(U, list([3, "Glass Orchard"], [7, "Paper Moons"]), {
      presetVolumes: { [k(3)]: 40, [k(7)]: 25 },
      presetVolumeNames: { [k(3)]: "Paper Moons", [k(7)]: "Paper Moons" },
    });
    expect(out).toEqual({
      presetVolumes: { [k(7)]: 25 },
      presetVolumeNames: { [k(7)]: "Paper Moons" },
    });
  });

  it("leaves a level whose name two slots share where it is, holding for neither", () => {
    const maps = {
      presetVolumes: { [k(3)]: 40 },
      presetVolumeNames: { [k(3)]: "Paper Moons" },
    };
    expect(
      healPresetVolumes(U, list([3, "Tin Weather"], [5, "Paper Moons"], [6, "Paper Moons"]), maps),
    ).toBeNull();
  });

  it("changes nothing for a list with no named preset, nor another streamer's levels", () => {
    const maps = {
      presetVolumes: { [k(3)]: 40, [k(3, OTHER)]: 60 },
      presetVolumeNames: { [k(3)]: "Paper Moons", [k(3, OTHER)]: "Tin Weather" },
    };
    expect(healPresetVolumes(U, [], maps)).toBeNull();
    expect(healPresetVolumes(U, list([3, "Paper Moons"]), maps)).toBeNull();
    expect(healPresetVolumes(U, list([3, "Glass Orchard"]), maps)).toEqual({
      presetVolumes: { [k(3, OTHER)]: 60 },
      presetVolumeNames: { [k(3, OTHER)]: "Tin Weather" },
    });
  });
});

describe("a move or a delete made here carries every slot-keyed fact", () => {
  const presets = list([1, "A"], [2, "B"], [5, "C"], [7, "D"]);

  it("re-seats the presets between the two slots as the streamer does", () => {
    expect([...slotsAfterMove(presets, 1, 5)]).toEqual([
      [2, 1],
      [5, 2],
      [1, 5],
    ]);
    expect([...slotsAfterMove(presets, 7, 2)]).toEqual([
      [7, 2],
      [2, 5],
      [5, 7],
    ]);
    expect(slotsAfterMove(presets, 1, 4).size).toBe(0);
  });

  it("moves the level, its name, the artist and the saved queue together, this streamer's only", () => {
    const maps = {
      presetVolumes: { [k(1)]: 40, [k(1, OTHER)]: 60 },
      presetVolumeNames: { [k(1)]: "A" },
      presetArtists: { [k(2)]: "Glass Orchard" },
      queueSignatures: { [k(5)]: "q1" },
    };
    expect(moveSlotFacts(U, slotsAfterMove(presets, 1, 5), maps)).toEqual({
      presetVolumes: { [k(5)]: 40, [k(1, OTHER)]: 60 },
      presetVolumeNames: { [k(5)]: "A" },
      presetArtists: { [k(1)]: "Glass Orchard" },
      queueSignatures: { [k(2)]: "q1" },
    });
  });

  it("drops every fact of a deleted slot", () => {
    const maps = {
      presetVolumes: { [k(2)]: 40 },
      presetVolumeNames: { [k(2)]: "B" },
      presetArtists: { [k(2)]: "Glass Orchard", [k(5)]: "Paper Moons" },
      queueSignatures: { [k(2)]: "q1" },
    };
    expect(dropSlotFacts(U, 2, maps)).toEqual({
      presetVolumes: {},
      presetVolumeNames: {},
      presetArtists: { [k(5)]: "Paper Moons" },
      queueSignatures: {},
    });
  });
});

describe("a rename made here keeps the level, whatever name the streamer keeps", () => {
  it("lets the slot's recorded name go, so the list read next names the level", () => {
    const maps = {
      presetVolumes: { [k(3)]: 40, [k(3, OTHER)]: 22 },
      presetVolumeNames: { [k(3)]: "Paper Moons", [k(3, OTHER)]: "Paper Moons" },
    };
    const renamed = renamedSlotFacts(U, 3, maps);
    expect(renamed).toEqual({ presetVolumeNames: { [k(3, OTHER)]: "Paper Moons" } });
    // the streamer kept the new name shortened
    expect(
      healPresetVolumes(U, list([3, "Glass Orchard Live at the Ha"]), { ...maps, ...renamed }),
    ).toEqual({
      presetVolumes: { [k(3)]: 40, [k(3, OTHER)]: 22 },
      presetVolumeNames: { [k(3)]: "Glass Orchard Live at the Ha", [k(3, OTHER)]: "Paper Moons" },
    });
    expect(renamedSlotFacts(U, 4, maps)).toBeNull();
  });
});
