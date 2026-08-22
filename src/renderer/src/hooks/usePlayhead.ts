import { useEffect, useState } from "react";
import { useStore } from "@/store";

/**
 * The streamer reports position at ~1 Hz; interpolate between syncs at 4 Hz for a
 * smooth playhead (vibinui's PlayheadManager pattern).
 */
export function usePlayhead(): { position: number; duration: number | null } {
  const playhead = useStore((s) => s.playhead);
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const [, forceTick] = useState(0);

  const playing = playState?.state === "play";

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [playing]);

  const duration = playState?.metadata?.duration ?? nowPlaying?.display?.progress?.duration ?? null;

  let position = playhead?.secs ?? 0;
  if (playhead && playing) {
    position += (Date.now() - playhead.at) / 1000;
  }
  if (duration != null && duration > 0) position = Math.min(position, duration);

  return { position, duration };
}
