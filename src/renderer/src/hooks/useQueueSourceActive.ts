import { useStore } from "@/store";
import { activeSourceId } from "@/lib/format";

/**
 * Whether the queue is the audible source (the media player is the active source): the one
 * reading of it every surface that marks a playing row or card asks (0.11.0 sweep). A
 * boolean selector, so a surface re-renders when the answer flips, not on every zone or
 * now-playing push.
 */
export function useQueueSourceActive(): boolean {
  return useStore((s) => activeSourceId(s.zoneState, s.nowPlaying) === "MEDIA_PLAYER");
}
