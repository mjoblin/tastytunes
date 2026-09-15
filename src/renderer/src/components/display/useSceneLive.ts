import { isRadioMetadata } from "@shared/smoip";
import { useStore } from "@/store";
import { usePlayingAnalysis } from "@/components/media/Waveform";
import { nowPlayingInfoTarget } from "@/lib/mediaInfo";

/**
 * WHETHER THE SCENES HAVE SOMETHING REAL TO DRAW (2026-09-15, the user: the
 * docs say the scenes need local media, "but in the ui it's not obvious").
 * The feed marks every frame `real` when an analysis drives it; this is that
 * truth as React state, with the reason when it is not, so the picker can
 * show its tiles still and say why, and a host can caption the wall or the
 * tile with the same words. One home for the words, sceneIdleLine.
 *
 * The reasons, in the order they are told apart:
 *  - `radio`: a station plays (radio never has an analysis);
 *  - `elsewhere`: the source is not the library — AirPlay, a cast, a stream
 *    the library cannot place (nowPlayingInfoTarget's own local test, so this
 *    and the Info modal agree on what "local" means);
 *  - `analyzing`: a library track whose analysis is still being made (the
 *    first play of a track decodes and measures it, a few seconds);
 *  - `unanalyzed`: a library track the app could not read (the server refused
 *    the file, or the decode failed).
 */
export type SceneIdle = "radio" | "elsewhere" | "analyzing" | "unanalyzed";

export function useSceneLive(enabled: boolean): { live: boolean; idle: SceneIdle | null } {
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const analysis = usePlayingAnalysis(enabled);
  if (isRadioMetadata(playState?.metadata)) return { live: false, idle: "radio" };
  if (nowPlayingInfoTarget(playState, nowPlaying)?.localQuery == null)
    return { live: false, idle: "elsewhere" };
  if (analysis === "loading") return { live: false, idle: "analyzing" };
  if (analysis == null) return { live: false, idle: "unanalyzed" };
  return { live: true, idle: null };
}

/** The picker's notice, in the row between the Sleeve and Shuffle tiles (the user, 2026-09-15:
 *  a line in the footer was "too hidden"): what the scenes need, and what is playing instead. */
export function sceneIdleNotice(idle: SceneIdle): { head: string; body: string } {
  switch (idle) {
    case "analyzing":
      return { head: "Analyzing the track…", body: "The scenes draw once it's done." };
    case "unanalyzed":
      return {
        head: "This track couldn't be analyzed.",
        body: "The scenes need a local library track the app can read.",
      };
    case "radio":
      return { head: "Scenes need a local library track.", body: "A station is playing." };
    default:
      return {
        head: "Scenes need a local library track.",
        body: "This track isn't from your library.",
      };
  }
}

/** The one line that says why a scene is not drawing, in the register: the scene by name,
 *  the reason in plain words (the user's wording for the common case, 2026-09-15) — the wall's
 *  caption and the tile chip's tip. */
export function sceneIdleLine(label: string, idle: SceneIdle): string {
  switch (idle) {
    case "analyzing":
      return "Analyzing the track…";
    case "unanalyzed":
      return `${label} couldn't analyze this track.`;
    default:
      return `${label} needs a local library track.`;
  }
}
