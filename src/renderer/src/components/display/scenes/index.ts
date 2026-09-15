import {
  Disc3,
  Map,
  Moon,
  Radar,
  Blend,
  CircleDot,
  Mountain,
  Orbit as OrbitIcon,
  Shuffle,
  Rows3,
  Terminal as TerminalIcon,
  Type as TypeIcon,
  Waves,
} from "lucide-react";
import type { DisplayScene, SceneSettingValue } from "@shared/model";
import { orderScenes, sceneText } from "@shared/scenes";
import type { AnyScene, SceneId, SceneKey, SceneSettingDef, SceneSettings } from "./types";
import { Tide } from "./tide";
import { Terrain } from "./terrain";
import { Orbit } from "./orbit";
import { Type } from "./type";
import { Survey, SURVEY_KEY, SURVEY_SETTINGS } from "./survey";
import { Conduit, CONDUIT_KEY, CONDUIT_SETTINGS } from "./conduit";
import { Confluence, CONFLUENCE_KEY, CONFLUENCE_SETTINGS } from "./confluence";
import { Pit, PIT_KEY, PIT_SETTINGS } from "./pit";
import { Roll, ROLL_KEY, ROLL_SETTINGS } from "./roll";
import { Sea, SEA_KEY, SEA_SETTINGS } from "./sea";
import { Terminal, TERMINAL_KEY, TERMINAL_SETTINGS } from "./terminal";

/**
 * THE SCENES registry: the picker, the palette, Tab and the shuffle all
 * read it. A definition declares how the scene is drawn (`kind`, so a
 * machine without WebGL can be told honestly), how to READ it (`key`), and
 * the settings it exposes (auto-rendered in the picker, persisted per
 * scene). The registry is static; "plugin" means a well-factored module
 * with a stable contract, a new scene being its own folder plus one entry.
 */
export interface SceneDef {
  id: DisplayScene;
  label: string;
  blurb: string;
  icon: typeof Disc3;
  /** face = the DOM face (Sleeve); 2d = a canvas drawing; gl = a fragment shader; three = a three.js world. */
  kind: "face" | "2d" | "gl" | "three" | "shuffle";
  key?: SceneKey;
  settings?: SceneSettingDef[];
  /** The scene IS its words (Type, Terminal): the Now Playing tile draws them whatever its
   *  words toggle says, and the toggle is disabled there. */
  essentialWords?: true;
}

/** A scene's name and description come from the shared text (shared/scenes.ts, 2026-09-14),
 *  the one home the MCP bridge's list_scenes reads too. */
const text = (id: DisplayScene): { label: string; blurb: string } => {
  const { label, blurb } = sceneText(id);
  return { label, blurb };
};

export const SCENES: SceneDef[] = [
  {
    id: "sleeve",
    ...text("sleeve"),
    icon: Disc3,
    kind: "face",
    key: {
      reads: [{ shows: "The picture", means: "The album art." }],
    },
  },
  {
    id: "tide",
    ...text("tide"),
    icon: Waves,
    kind: "2d",
    key: {
      reads: [
        { shows: "Water height", means: "The overall loudness." },
        { shows: "Wave size", means: "The bass." },
        { shows: "Spray off the crests", means: "A snare or a hi-hat." },
        { shows: "The water lifting", means: "A kick drum, or the whole sea on a drop." },
        {
          shows: "Faint line above the water",
          means: "The loudness still to come, read left to right.",
        },
        {
          shows: "The moon",
          means:
            "The high frequencies. A hi-hat glints in the reflection and a drop brightens the moon.",
        },
        { shows: "Lit crests", means: "A snare." },
      ],
      honesty: ["The waves represent the bass, not the waveform."],
    },
  },
  {
    id: "terrain",
    ...text("terrain"),
    icon: Mountain,
    kind: "2d",
    key: {
      reads: [
        { shows: "The ridge", means: "The track's loudness over time, as three layers of hills." },
        {
          shows: "The glow behind the ridge",
          means: "Track position and how loud the music is. Flashes on a kick drum.",
        },
        { shows: "Left of the glow", means: "The last half minute." },
        { shows: "Right of the glow", means: "The next minute." },
        { shows: "Signposts", means: "The lyrics." },
        { shows: "Bands across the sky", means: "The track's sections, warmer for a chorus." },
        {
          shows: "The weather",
          means:
            "The sky is warmer and brighter in a chorus, and starry and misty in a quiet passage.",
        },
      ],
      honesty: [
        "Loudness is measured ten times a second, so a single hit shows as a bump rather than a spike.",
      ],
    },
  },
  {
    id: "orbit",
    ...text("orbit"),
    icon: OrbitIcon,
    kind: "2d",
    key: {
      reads: [
        {
          shows: "Six rings",
          means: "Six frequency bands, bass on the inside and highs on the outside.",
        },
        { shows: "A ring widening", means: "That band's level." },
        {
          shows: "A ring jumping",
          means: "A drum hit in that band. Kicks on the inner rings, hi-hats on the outer.",
        },
        {
          shows: "The comet",
          means: "Track position. It brightens on each beat, more on the first beat of a bar.",
        },
        {
          shows: "The color at the center",
          means: "The key the music is in, each key a color on a wheel.",
        },
      ],
    },
  },
  {
    id: "type",
    ...text("type"),
    icon: TypeIcon,
    essentialWords: true,
    kind: "2d",
    key: {
      reads: [
        { shows: "The lyrics", means: "The line being sung, or the title when there are none." },
        { shows: "The swell", means: "The bass. Pulses represent kick drums and drops." },
        { shows: "The hairline", means: "Progress through the lyric." },
      ],
    },
    settings: [{ key: "motion", label: "Motion", kind: "toggle", default: true }],
  },
  {
    id: "survey",
    ...text("survey"),
    icon: Map,
    kind: "three",
    key: SURVEY_KEY,
    settings: SURVEY_SETTINGS,
  },
  {
    id: "conduit",
    ...text("conduit"),
    icon: Radar,
    kind: "three",
    key: CONDUIT_KEY,
    settings: CONDUIT_SETTINGS,
  },
  {
    id: "confluence",
    ...text("confluence"),
    icon: Blend,
    kind: "three",
    key: CONFLUENCE_KEY,
    settings: CONFLUENCE_SETTINGS,
  },
  {
    id: "pit",
    ...text("pit"),
    icon: CircleDot,
    kind: "2d",
    key: PIT_KEY,
    settings: PIT_SETTINGS,
  },
  {
    id: "roll",
    ...text("roll"),
    icon: Rows3,
    kind: "2d",
    key: ROLL_KEY,
    settings: ROLL_SETTINGS,
  },
  {
    id: "sea",
    ...text("sea"),
    icon: Moon,
    kind: "three",
    key: SEA_KEY,
    settings: SEA_SETTINGS,
  },
  {
    id: "terminal",
    ...text("terminal"),
    icon: TerminalIcon,
    essentialWords: true,
    kind: "2d",
    key: TERMINAL_KEY,
    settings: TERMINAL_SETTINGS,
  },
  {
    id: "shuffle",
    ...text("shuffle"),
    icon: Shuffle,
    kind: "shuffle",
  },
];

export const ABSTRACT_SCENES: SceneId[] = [
  "tide",
  "terrain",
  "orbit",
  "type",
  "survey",
  "conduit",
  "confluence",
  "pit",
  "roll",
  "sea",
  "terminal",
];
export const isAbstract = (id: DisplayScene): id is SceneId => id !== "sleeve" && id !== "shuffle";

/** The scenes as the picker shows them: alphabetical by label, Shuffle last (the user's word);
 *  Tab and Shuffle walk the same order, so the keyboard, the picker and the shuffle agree. */
export const SCENES_ORDERED: SceneDef[] = orderScenes(SCENES);
/** The abstract scenes in that order, for Shuffle to cycle through. */
export const ABSTRACT_ORDERED: SceneId[] = SCENES_ORDERED.map((s) => s.id).filter(isAbstract);

export function sceneDef(id: DisplayScene): SceneDef {
  const def = SCENES.find((s) => s.id === id);
  if (!def) throw new Error(`unknown scene ${id}`);
  return def;
}

export function makeScene(id: SceneId): AnyScene {
  switch (id) {
    case "tide":
      return new Tide();
    case "terrain":
      return new Terrain();
    case "orbit":
      return new Orbit();
    case "type":
      return new Type();
    case "survey":
      return new Survey();
    case "conduit":
      return new Conduit();
    case "confluence":
      return new Confluence();
    case "pit":
      return new Pit();
    case "roll":
      return new Roll();
    case "sea":
      return new Sea();
    case "terminal":
      return new Terminal();
  }
}

/** Anything Shuffle may show: every scene but Shuffle itself (the sleeve included, if asked in). */
export type Shuffleable = Exclude<DisplayScene, "shuffle">;
export const SHUFFLE_POOL: Shuffleable[] = SCENES_ORDERED.map((s) => s.id).filter(
  (id): id is Shuffleable => id !== "shuffle",
);

/**
 * Shuffle's next scene: the one after the last in the picker's alphabetical order, or a random
 * one that is never the one before, from the pool less the scenes the user has left out (an
 * empty pool falls back to every scene rather than nothing).
 */
export function pickShuffled(
  previous: Shuffleable | null,
  order: "sequential" | "random" = "random",
  exclude: readonly string[] = ["sleeve"],
): Shuffleable {
  let pool = SHUFFLE_POOL.filter((id) => !exclude.includes(id));
  if (pool.length === 0) pool = SHUFFLE_POOL;
  if (order === "random") {
    const others = pool.filter((id) => id !== previous);
    const from = others.length ? others : pool;
    return from[Math.floor(Math.random() * from.length)];
  }
  const i = previous ? pool.indexOf(previous) : -1;
  return pool[(i + 1) % pool.length];
}

export function defaultSettingsFor(def: SceneDef): SceneSettings {
  const out: SceneSettings = {};
  for (const s of def.settings ?? []) out[s.key] = s.default;
  return out;
}

/** Persisted values over the defaults, discarding anything that no longer
 *  fits its definition: a setting that changed type or range between
 *  versions resets rather than feeding a nonsense value into a scene. */
export function resolveSettings(
  def: SceneDef,
  persisted: Record<string, SceneSettingValue> | undefined,
): SceneSettings {
  const out = defaultSettingsFor(def);
  if (!persisted) return out;
  for (const s of def.settings ?? []) {
    const v = persisted[s.key];
    if (v === undefined) continue;
    if (s.kind === "slider" && typeof v === "number" && Number.isFinite(v))
      out[s.key] = Math.min(Math.max(v, s.min), s.max);
    else if (s.kind === "toggle" && typeof v === "boolean") out[s.key] = v;
    else if (s.kind === "select" && typeof v === "string" && s.options.some((o) => o.value === v))
      out[s.key] = v;
  }
  return out;
}
