import { useEffect, useRef, useState } from "react";
import type { DisplayScene } from "@shared/model";
import { useStore } from "@/store";
import type { NowPlayingMeta } from "@/lib/format";
import { pickShuffled, type Shuffleable } from "./scenes";

const DEFAULT_EXCLUDE: readonly string[] = ["sleeve"];

/**
 * The scene a host shows for the playing track: the one its setting names,
 * or when that is Shuffle, the shuffle's draw for this track (never the one
 * before) on the display-wide order, cadence and exclusions. Each host draws
 * for itself: display mode and the Now Playing tile keep separate choices
 * (the user's call, 2026-09-12), so separate draws.
 */
export function useShuffledScene(
  chosen: DisplayScene,
  meta: Pick<NowPlayingMeta, "title" | "subtitle" | "album">,
): { shuffled: Shuffleable; active: Shuffleable } {
  const shuffleOrder = useStore((s) => s.settings.displayShuffleOrder ?? "random");
  const shuffleEvery = useStore((s) => s.settings.displayShuffleEvery ?? 1);
  const excludeRaw = useStore((s) => s.settings.displayShuffleExclude);
  const shuffleExclude = excludeRaw ?? DEFAULT_EXCLUDE;
  const trackSig = `${meta.title ?? ""}␟${meta.subtitle ?? ""}␟${meta.album ?? ""}`;
  const albumSig = meta.album ?? "";
  const [shuffled, setShuffled] = useState<Shuffleable>(() =>
    pickShuffled(null, shuffleOrder, shuffleExclude),
  );
  const shuffledRef = useRef(shuffled);
  // how many tracks the shown scene has had, and the album it began on; the draw is due when
  // the count reaches "every" (or the album changes), and at once when Shuffle is chosen
  const sinceRef = useRef(0);
  const albumRef = useRef(albumSig);
  const wasShuffleRef = useRef(false);
  useEffect(() => {
    if (chosen !== "shuffle") {
      wasShuffleRef.current = false;
      return;
    }
    let due = !wasShuffleRef.current;
    wasShuffleRef.current = true;
    if (shuffleEvery === "album") {
      if (albumSig !== albumRef.current) due = true;
    } else {
      sinceRef.current += 1;
      if (sinceRef.current >= shuffleEvery) due = true;
    }
    if (!due) return;
    sinceRef.current = 0;
    albumRef.current = albumSig;
    const next = pickShuffled(shuffledRef.current, shuffleOrder, shuffleExclude);
    shuffledRef.current = next;
    setShuffled(next);
    // the order and the exclusions ride the refs' values at draw time; only a track or a mode
    // change draws
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackSig, chosen]);
  // a scene left out while it is up gives way at once
  useEffect(() => {
    if (chosen !== "shuffle" || !shuffleExclude.includes(shuffledRef.current)) return;
    const next = pickShuffled(shuffledRef.current, shuffleOrder, shuffleExclude);
    shuffledRef.current = next;
    setShuffled(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shuffleExclude.join(","), chosen]);
  return { shuffled, active: chosen === "shuffle" ? shuffled : chosen };
}
