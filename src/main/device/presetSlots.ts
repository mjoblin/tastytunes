// A PRESET'S OWN FACTS FOLLOW THE PRESET, NOT ITS SLOT NUMBER (0.16.0, toward 1.0). The app keeps
// three things per preset slot, keyed by streamer and slot (presetVolumeKey): the level a recall
// sets (presetVolumes), the artist of an album saved from the Library (presetArtists) and the exact
// queue a queue preset holds (queueSignatures). A slot's number moves under its preset: a move
// re-seats every preset between the two slots, a save replaces one, a delete empties one, and
// another app can do any of them. The level is the one that does harm (it sets the volume on other
// music), so it carries its preset's name (presetVolumeNames) and holds only while the names agree
// (presetVolumeHolds); when the presets list arrives, a level whose preset now sits in another slot
// moves there, and one whose preset no slot holds is dropped. A move or a delete made here moves or
// drops all three at once. Pure, so the rules are unit-tested; DeviceManager applies them.

import { type AppSettings, presetVolumeKey } from "@shared/model";
import { nameKey } from "@shared/keys";

export type SlotMaps = Pick<
  AppSettings,
  "presetVolumes" | "presetVolumeNames" | "presetArtists" | "queueSignatures"
>;

/** A preset as the list reads it: its slot and its name. */
export interface SlotPreset {
  id: number | null;
  name: string | null;
}

const prefixOf = (udn: string | null | undefined): string => presetVolumeKey(udn, 0).slice(0, -1);

/** This streamer's entries of a slot-keyed map, by slot, and the other streamers' entries. */
function split<T>(
  map: Readonly<Record<string, T>>,
  prefix: string,
): { mine: Map<number, T>; others: Record<string, T> } {
  const mine = new Map<number, T>();
  const others: Record<string, T> = {};
  for (const [key, value] of Object.entries(map)) {
    const slot = key.startsWith(prefix) ? Number(key.slice(prefix.length)) : NaN;
    if (Number.isInteger(slot)) mine.set(slot, value);
    else others[key] = value;
  }
  return { mine, others };
}

const sameEntries = <T>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>): boolean =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([k, v]) => k in b && b[k] === v);

/**
 * The levels and their names after a presets list arrives, or null when nothing changes:
 * - a level set before names were kept adopts the name of the preset in its slot;
 * - a level whose preset now sits in one other slot moves there (a move made in any app);
 * - a level whose preset no slot holds is dropped (deleted or saved over), and so is a level for
 *   an empty slot;
 * - a level whose name two other slots share stays where it is, holding for neither;
 * - a level never takes a slot whose own preset already has one.
 * A list with no named preset changes nothing: a streamer mid-read or in standby may answer one.
 */
export function healPresetVolumes(
  udn: string | null | undefined,
  presets: readonly SlotPreset[],
  maps: Pick<SlotMaps, "presetVolumes" | "presetVolumeNames">,
): Pick<SlotMaps, "presetVolumes" | "presetVolumeNames"> | null {
  const bySlot = new Map<number, string>();
  const byName = new Map<string, number[]>();
  for (const p of presets) {
    if (p.id == null || !p.name) continue;
    bySlot.set(p.id, p.name);
    const key = nameKey(p.name);
    byName.set(key, [...(byName.get(key) ?? []), p.id]);
  }
  if (bySlot.size === 0) return null;

  const prefix = prefixOf(udn);
  const levels = split(maps.presetVolumes, prefix);
  const names = split(maps.presetVolumeNames, prefix);
  const placed = new Map<number, { level: number; name: string }>();
  const moving: Array<{ to: number; level: number; name: string }> = [];
  const held: Array<{ at: number; level: number; name: string }> = [];
  for (const [slot, level] of levels.mine) {
    const recorded = names.mine.get(slot);
    const current = bySlot.get(slot);
    if (recorded == null) {
      if (current != null) placed.set(slot, { level, name: current });
      continue;
    }
    if (current != null && nameKey(current) === nameKey(recorded)) {
      placed.set(slot, { level, name: recorded });
      continue;
    }
    const homes = byName.get(nameKey(recorded)) ?? [];
    if (homes.length === 1) moving.push({ to: homes[0], level, name: recorded });
    else if (homes.length > 1) held.push({ at: slot, level, name: recorded });
  }
  for (const m of moving) if (!placed.has(m.to)) placed.set(m.to, m);
  for (const h of held) if (!placed.has(h.at)) placed.set(h.at, h);

  const presetVolumes = { ...levels.others };
  const presetVolumeNames = { ...names.others };
  for (const [slot, { level, name }] of placed) {
    presetVolumes[presetVolumeKey(udn, slot)] = level;
    presetVolumeNames[presetVolumeKey(udn, slot)] = name;
  }
  return sameEntries(presetVolumes, maps.presetVolumes) &&
    sameEntries(presetVolumeNames, maps.presetVolumeNames)
    ? null
    : { presetVolumes, presetVolumeNames };
}

/**
 * Where each preset lands after a move made here, old slot to new: the moved preset takes the
 * target's place in the list's order, each preset between shifts one place, and all are re-seated
 * into the same slot numbers (how /presets/list reads back after a real move; the mock and the
 * demo streamer do the same). Empty when either slot holds nothing.
 */
export function slotsAfterMove(
  presets: readonly SlotPreset[],
  from: number,
  to: number,
): Map<number, number> {
  const slots = presets.flatMap((p) => (p.id != null ? [p.id] : []));
  const fromIdx = slots.indexOf(from);
  const toIdx = slots.indexOf(to);
  const moved = new Map<number, number>();
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return moved;
  const order = [...slots];
  const [taken] = order.splice(fromIdx, 1);
  order.splice(toIdx, 0, taken);
  order.forEach((oldSlot, i) => {
    if (oldSlot !== slots[i]) moved.set(oldSlot, slots[i]);
  });
  return moved;
}

/** Every slot-keyed map with this streamer's entries re-keyed by a move (slotsAfterMove). */
export function moveSlotFacts(
  udn: string | null | undefined,
  moved: ReadonlyMap<number, number>,
  maps: SlotMaps,
): SlotMaps {
  const prefix = prefixOf(udn);
  const remap = <T>(map: Readonly<Record<string, T>>): Record<string, T> => {
    const { mine, others } = split(map, prefix);
    const out = { ...others };
    for (const [slot, value] of mine) out[presetVolumeKey(udn, moved.get(slot) ?? slot)] = value;
    return out;
  };
  return {
    presetVolumes: remap(maps.presetVolumes),
    presetVolumeNames: remap(maps.presetVolumeNames),
    presetArtists: remap(maps.presetArtists),
    queueSignatures: remap(maps.queueSignatures),
  };
}

/**
 * The levels' names after a rename made here: the slot's recorded name is let go, so the list
 * read next adopts the name the streamer kept (the heal's rule for a level with no name).
 * Recording the name sent instead would drop the level if the streamer ever stored it
 * differently, shortened, say. Null when the slot has no recorded name.
 */
export function renamedSlotFacts(
  udn: string | null | undefined,
  slot: number,
  maps: Pick<SlotMaps, "presetVolumeNames">,
): Pick<SlotMaps, "presetVolumeNames"> | null {
  const key = presetVolumeKey(udn, slot);
  if (!(key in maps.presetVolumeNames)) return null;
  const { [key]: _sent, ...presetVolumeNames } = maps.presetVolumeNames;
  return { presetVolumeNames };
}

/** Every slot-keyed map without this streamer's slot: the preset there was deleted. */
export function dropSlotFacts(
  udn: string | null | undefined,
  slot: number,
  maps: SlotMaps,
): SlotMaps {
  const key = presetVolumeKey(udn, slot);
  const without = <T>(map: Readonly<Record<string, T>>): Record<string, T> => {
    const out = { ...map };
    delete out[key];
    return out;
  };
  return {
    presetVolumes: without(maps.presetVolumes),
    presetVolumeNames: without(maps.presetVolumeNames),
    presetArtists: without(maps.presetArtists),
    queueSignatures: without(maps.queueSignatures),
  };
}
