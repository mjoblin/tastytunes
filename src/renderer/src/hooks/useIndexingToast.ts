import { useEffect } from "react";
import type { MediaIndexStatus } from "@shared/model";
import { useStore } from "@/store";
import { fmtCount } from "@/lib/format";

/** How long a burst of libraries finishing together is gathered into one
 *  toast — several servers indexed at startup land within a few seconds. */
const BURST_MS = 2500;

/**
 * One success toast when a media index goes building → ready WHILE THE
 * LIBRARY SCREEN IS NOT SHOWING (user ask, 2026-09-01): "minitunes indexed ·
 * 4,590 tracks", or "2 libraries indexed" for a burst, with the house View
 * jump to the Library. Never while the Library shows — the root doors
 * already announce it in place (their count line fades from "Indexing…" to
 * the count), and a toast there would be the double feedback the toast rule
 * forbids. Failures stay on the door and in Settings: the failure-toast rule
 * is for writes.
 *
 * Only TRANSITIONS toast. The map of last-seen states is seeded from the
 * store at subscribe time, so an index that was already ready when the app
 * (or this effect, under StrictMode's re-run) came up says nothing.
 *
 * And only builds someone MEANT: a server's first index, or a rebuild the
 * user asked for. A build the app started on its own to keep an index it
 * already had honest arrives marked `quiet` (the streamer's counter moved,
 * the TTL passed, the schema changed, a stale id was revalidated before an
 * answer was trusted) and says nothing when it lands (user, 2026-09-15: the
 * Evo's USB ids rotate across every standby, so every playlist play and
 * Open in Library after a sleep toasted "streamer indexed · 0 tracks").
 */
export function useIndexingToast(): void {
  useEffect(() => {
    const last = new Map<string, { state: MediaIndexStatus["state"]; quiet: boolean }>();
    const seen = (s: MediaIndexStatus): { state: MediaIndexStatus["state"]; quiet: boolean } => ({
      state: s.state,
      quiet: s.quiet === true,
    });
    for (const s of useStore.getState().mediaIndex) last.set(s.udn, seen(s));
    let pending: MediaIndexStatus[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      timer = null;
      const done = pending;
      pending = [];
      if (done.length === 0 || useStore.getState().screen === "library") return;
      const text =
        done.length === 1
          ? `${done[0].serverName} indexed · ${fmtCount(done[0].tracks)} ${done[0].tracks === 1 ? "track" : "tracks"}`
          : `${done.length} libraries indexed`;
      useStore.getState().showToast({
        kind: "success",
        text,
        action: { label: "View", screen: "library" },
      });
    };
    const unsubscribe = useStore.subscribe((state) => {
      for (const s of state.mediaIndex) {
        const was = last.get(s.udn);
        last.set(s.udn, seen(s));
        if (
          was?.state === "building" &&
          !was.quiet &&
          s.state === "ready" &&
          state.screen !== "library"
        ) {
          pending.push(s);
          if (timer) clearTimeout(timer);
          timer = setTimeout(flush, BURST_MS);
        }
      }
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
