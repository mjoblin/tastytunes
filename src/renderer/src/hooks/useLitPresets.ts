import { useMemo } from "react";
import { litPresetIds } from "@shared/litPresets";
import type { PresetItem } from "@shared/smoip";
import { useStore } from "@/store";

/**
 * Which presets are PLAYING, for the window: the store's state handed to the one rule
 * (shared/litPresets, where its memo of why lives; the display server lights another screen's
 * presets with it too). Lifted out of PresetsScreen 2026-07-28 so the tray panel gets the same
 * answer, and out of the window 2026-11-24 so main does.
 */
export function useLitPresets(
  items: PresetItem[],
  /** A recall issued while the streamer slept owns the lamp until it lands —
   *  screen-local state, so the caller passes it (see PresetsScreen). */
  wakeRecallId: number | null = null,
): Set<number> {
  const zoneState = useStore((s) => s.zoneState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const playState = useStore((s) => s.playState);
  const queue = useStore((s) => s.queue);
  const systemInfo = useStore((s) => s.systemInfo);
  const systemPower = useStore((s) => s.systemPower);
  const waking = useStore((s) => s.waking);
  const lastRecalledPresetId = useStore((s) => s.lastRecalledPresetId);
  const deadPresets = useStore((s) => s.deadPresets);
  const queueSignatures = useStore((s) => s.settings.queueSignatures);

  return useMemo(
    () =>
      litPresetIds(items, {
        zoneState,
        nowPlaying,
        playState,
        queue,
        systemInfo,
        systemPower,
        waking,
        lastRecalledPresetId,
        deadPresets,
        queueSignatures,
        wakeRecallId,
      }),
    [
      items,
      zoneState,
      nowPlaying,
      playState,
      queue,
      systemInfo,
      systemPower,
      waking,
      lastRecalledPresetId,
      deadPresets,
      queueSignatures,
      wakeRecallId,
    ],
  );
}
