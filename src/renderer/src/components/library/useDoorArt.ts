import { useEffect, useMemo, useState } from "react";
import { audioAnalysisKey } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { usePlayStats } from "@/lib/playStats";
import { analyzedKeys } from "@/lib/audioAnalysis";
import { useIndexPools } from "@/hooks/useIndexPools";
import { type DoorPicks, pickDoorArt, waveBars } from "@/components/library/doorPicks";

/** One Tracks-door waveform: its track's content key and its bars (0..1). */
export interface DoorWave {
  key: string;
  bars: number[];
}

/** The Tracks door draws four rows; each waveform is this many bars. */
export const DOOR_WAVES = 4;
export const WAVE_BARS = 64;

/**
 * The doors' pictures (doorPicks) from what the app already holds: the ready indexes' pools (one
 * snapshot per window, useIndexPools), the listening record (usePlayStats, so its off switch
 * turns the ranking off too) and the stored analyses. The waveforms are asked for in two reads,
 * which keys have an analysis (lib/audioAnalysis, cache-only) and then the four to draw, and are
 * kept per candidate list for the session, so a return to the root draws them at once. With
 * waveforms off in Settings the Tracks door shows its strips.
 */
export function useDoorArt(enabled: boolean): {
  picks: DoorPicks | null;
  /** null while being asked; fewer than two is the strips' cue. */
  waves: DoorWave[] | null;
} {
  const pools = useIndexPools(enabled);
  const stats = usePlayStats();
  const picks = useMemo(
    () => (enabled && pools ? pickDoorArt(pools, stats.track) : null),
    [enabled, pools, stats],
  );
  const waveformsOn = useStore((s) => s.settings.waveforms);
  const sig = picks && waveformsOn ? picks.tracks.map(audioAnalysisKey).join("\u0000") : "";
  const [asked, setAsked] = useState<{ sig: string; waves: DoorWave[] } | null>(null);
  // asked again on every visit, the last answer shown meanwhile: a track analyzed since (a play
  // measures it) joins the door on the next visit, and only new waveforms are read in full
  useEffect(() => {
    if (sig === "") return;
    let stale = false;
    void wavesFor(sig.split("\u0000"), waveCache.get(sig) ?? []).then((waves) => {
      waveCache.set(sig, waves);
      if (!stale) setAsked({ sig, waves });
    });
    return () => {
      stale = true;
    };
  }, [sig]);
  const waves = !picks
    ? null
    : sig === ""
      ? []
      : asked?.sig === sig
        ? asked.waves
        : (waveCache.get(sig) ?? null);
  return { picks, waves };
}

const waveCache = new Map<string, DoorWave[]>();

async function wavesFor(keys: string[], last: DoorWave[]): Promise<DoorWave[]> {
  const chosen = (await analyzedKeys(keys)).slice(0, DOOR_WAVES);
  const known = new Map(last.map((w) => [w.key, w]));
  const read = await Promise.all(
    chosen.map(async (key): Promise<DoorWave | null> => {
      const had = known.get(key);
      if (had) return had;
      const a = await tt.audioAnalysisGet(key).catch(() => null);
      return a && a.peakQ.length >= WAVE_BARS ? { key, bars: waveBars(a.peakQ, WAVE_BARS) } : null;
    }),
  );
  return read.filter((w): w is DoorWave => w != null);
}
