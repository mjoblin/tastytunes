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
}

export const SCENES: SceneDef[] = [
  {
    id: "sleeve",
    label: "Sleeve",
    blurb: "The album art and title, with the current lyric beneath.",
    icon: Disc3,
    kind: "face",
    key: {
      reads: [
        { shows: "The picture", means: "the album art" },
        { shows: "The line beneath", means: "the current lyric, when the track has timed lyrics" },
      ],
    },
  },
  {
    id: "tide",
    label: "Tide",
    blurb: "A waterline that swells with the bass, with the lyrics riding the surface.",
    icon: Waves,
    kind: "2d",
    key: {
      reads: [
        { shows: "How high the water sits", means: "the overall loudness, following slowly" },
        { shows: "The size of the waves", means: "the bass" },
        { shows: "Spray off the crests", means: "a snare or a hi-hat" },
        { shows: "A heave of the water", means: "a kick drum. A drop heaves the whole sea" },
        {
          shows: "The faint line above the water",
          means: "the loudness still to come, with the future on the right",
        },
        {
          shows: "The moon and its reflection",
          means:
            "the reflection brightens with the high frequencies. A hi-hat sets off glints and a drop flares the moon",
        },
        { shows: "Lit crests", means: "a snare" },
        {
          shows: "Words on the water",
          means: "the current lyric, with the next line waiting below",
        },
      ],
      honesty: ["The waves are a picture, not the waveform."],
    },
  },
  {
    id: "terrain",
    label: "Terrain",
    blurb: "A flight over the track's loudness, with the next minute ahead of you.",
    icon: Mountain,
    kind: "2d",
    key: {
      reads: [
        {
          shows: "The ridge",
          means: "the track's loudness over time, drawn as three layers of hills",
        },
        {
          shows: "The glow behind the ridge",
          means: "your position and how loud the music is. It flashes on a kick drum",
        },
        { shows: "Left of the glow", means: "the last half minute" },
        { shows: "Right of the glow", means: "the next minute" },
        {
          shows: "Signposts",
          means: "the lyrics at the times they are sung, so you can see them coming",
        },
        { shows: "Bands across the sky", means: "the song's sections, warmer for a chorus" },
        {
          shows: "The weather",
          means:
            "the section you are in. A chorus warms and brightens the sky and a quiet passage brings out stars and mist",
        },
      ],
      honesty: [
        "Loudness is measured ten times a second, so a single hit shows as a bump rather than a spike.",
      ],
    },
  },
  {
    id: "orbit",
    label: "Orbit",
    blurb: "Six rings breathing with the music, with a comet marking your position in the track.",
    icon: OrbitIcon,
    kind: "2d",
    key: {
      reads: [
        {
          shows: "Six rings",
          means: "six frequency bands, bass on the inside and highs on the outside",
        },
        { shows: "A ring breathing", means: "that band's energy" },
        {
          shows: "A ring jumping",
          means: "a drum in that band. Kicks jump the inner rings and hi-hats the outer",
        },
        {
          shows: "The comet",
          means:
            "your position in the track. It flares on each beat, more on the first beat of a bar",
        },
        {
          shows: "The color at the center",
          means: "the key the music is in, mapped around a color wheel",
        },
        { shows: "Words on a ring", means: "the current lyric, with the next line waiting below" },
      ],
    },
  },
  {
    id: "type",
    label: "Type",
    blurb: "The current lyric alone, large, in the display font.",
    icon: TypeIcon,
    kind: "2d",
    key: {
      reads: [
        { shows: "The words", means: "the current lyric, or the title when there are no lyrics" },
        { shows: "Their arrival", means: "the start of the line" },
        { shows: "The swell", means: "the bass. A kick drum punches it and a drop punches harder" },
        { shows: "The hairline", means: "how far through the line you are" },
      ],
    },
    settings: [{ key: "motion", label: "Motion", kind: "toggle", default: true }],
  },
  {
    id: "survey",
    label: "Contour",
    blurb: "A map of the whole track as terrain, lit up to your current position.",
    icon: Map,
    kind: "three",
    key: SURVEY_KEY,
    settings: SURVEY_SETTINGS,
  },
  {
    id: "conduit",
    label: "Tunnel",
    blurb: "A flight down a tunnel made of the next half minute of the track.",
    icon: Radar,
    kind: "three",
    key: CONDUIT_KEY,
    settings: CONDUIT_SETTINGS,
  },
  {
    id: "confluence",
    label: "Ink",
    blurb:
      "Ink in water. The frequency bands flow into each other, the lyrics dissolve and you can stir it with the pointer.",
    icon: Blend,
    kind: "three",
    key: CONFLUENCE_KEY,
    settings: CONFLUENCE_SETTINGS,
  },
  {
    id: "pit",
    label: "Ball Pit",
    blurb: "Every drum hit thrown in as a rubber ball, piling up over the last minute.",
    icon: CircleDot,
    kind: "2d",
    key: PIT_KEY,
    settings: PIT_SETTINGS,
  },
  {
    id: "roll",
    label: "Piano Roll",
    blurb:
      "The whole track as a punched roll, with a head reading along the row and sparks on the drum hits.",
    icon: Rows3,
    kind: "2d",
    key: ROLL_KEY,
    settings: ROLL_SETTINGS,
  },
  {
    id: "sea",
    label: "Sea",
    blurb:
      "An open sea that swells with the loudness, under a moon whose reflection glints on the hi-hats.",
    icon: Moon,
    kind: "three",
    key: SEA_KEY,
    settings: SEA_SETTINGS,
  },
  {
    id: "terminal",
    label: "Terminal",
    blurb: "TASTYOS types the lyrics out on an amber screen, with the log scrolling up behind.",
    icon: TerminalIcon,
    kind: "2d",
    key: TERMINAL_KEY,
    settings: TERMINAL_SETTINGS,
  },
  {
    id: "shuffle",
    label: "Shuffle",
    blurb: "A different scene for every track.",
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
export const SCENES_ORDERED: SceneDef[] = [
  ...SCENES.filter((s) => s.id !== "shuffle").sort((a, b) => a.label.localeCompare(b.label)),
  ...SCENES.filter((s) => s.id === "shuffle"),
];
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
