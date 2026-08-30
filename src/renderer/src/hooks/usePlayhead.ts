import { useEffect, useState } from "react";
import { isRadioMetadata } from "@shared/smoip";
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

  const stationTunedAt = useStore((s) => s.stationTunedAt);

  // RADIO: the streamer reports no position at all (live-probed 2026-08-30 —
  // /zone/position answers empty and play_state has no position field), so
  // the stale track playhead would keep animating a lie. The app's tuned-at
  // stamp is the one honest elapsed: 0:00 at every station change, counting
  // how long this station has been playing.
  if (isRadioMetadata(playState?.metadata)) {
    const position = playing && stationTunedAt != null ? (Date.now() - stationTunedAt) / 1000 : 0;
    return { position, duration: null };
  }

  const duration = playState?.metadata?.duration ?? nowPlaying?.display?.progress?.duration ?? null;

  let position = playhead?.secs ?? 0;
  if (playhead && playing) {
    position += (Date.now() - playhead.at) / 1000;
  }
  if (duration != null && duration > 0) position = Math.min(position, duration);

  return { position, duration };
}
