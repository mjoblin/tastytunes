import type { DisplayScene } from "./model";

/**
 * THE SCENES' TEXT (2026-09-14, the MCP catch-up round): each scene's name and
 * its one-line description, the ONE home the picker's registry
 * (renderer/components/display/scenes) and the MCP bridge's list_scenes read,
 * so what an agent is told and what the picker shows cannot drift. The
 * registry itself stays in the renderer with the icons, the readings and the
 * settings; only the words are shared. In registry order; orderScenes() gives
 * the picker's.
 */
export interface SceneText {
  id: DisplayScene;
  label: string;
  blurb: string;
}

export const SCENE_TEXT: readonly SceneText[] = [
  { id: "sleeve", label: "Sleeve", blurb: "The album art and title." },
  {
    id: "tide",
    label: "Tide",
    blurb: "A waterline that rises with the bass, with the lyrics on the surface.",
  },
  {
    id: "terrain",
    label: "Terrain",
    blurb: "A flight along the track's loudness, with the next minute ahead.",
  },
  {
    id: "orbit",
    label: "Orbit",
    blurb: "Six rings, one per frequency band, and a comet marking the current track position.",
  },
  { id: "type", label: "Type", blurb: "The current lyric." },
  {
    id: "survey",
    label: "Contour",
    blurb: "The whole track as a contour map, lit up to the track position.",
  },
  {
    id: "conduit",
    label: "Tunnel",
    blurb: "A flight down a tunnel made of the next half minute of the track.",
  },
  { id: "confluence", label: "Ink", blurb: "Ink in water, one color per frequency band." },
  {
    id: "pit",
    label: "Ball Pit",
    blurb: "Each drum hit as a ball dropped into a pit, piling up over the last minute.",
  },
  {
    id: "roll",
    label: "Piano Roll",
    blurb: "The whole track as a punched roll, read by a head that sparks on drum hits.",
  },
  {
    id: "sea",
    label: "Sea",
    blurb: "A sea that swells with loudness, under a moon that glints on the hi-hats.",
  },
  {
    id: "terminal",
    label: "Terminal",
    blurb: "The lyrics typed onto a terminal, with a log scrolling up behind.",
  },
  { id: "shuffle", label: "Shuffle", blurb: "A different scene for every track." },
];

export function sceneText(id: DisplayScene): SceneText {
  const t = SCENE_TEXT.find((s) => s.id === id);
  if (!t) throw new Error(`unknown scene ${id}`);
  return t;
}

/** The picker's order: alphabetical by label, Shuffle last (the user's word); Tab, Shuffle
 *  and an agent's list walk the same order, so the keyboard, the picker and the tools agree. */
export function orderScenes<T extends { id: DisplayScene; label: string }>(
  list: readonly T[],
): T[] {
  return [
    ...list.filter((s) => s.id !== "shuffle").sort((a, b) => a.label.localeCompare(b.label)),
    ...list.filter((s) => s.id === "shuffle"),
  ];
}
