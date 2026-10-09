import { useEffect } from "react";
import { useStore } from "@/store";

const TEXT = "Waiting for the USB drive. This can take a minute after standby.";

/**
 * A WAIT ON THE USB DRIVE SAYS SO (0.10.0, user ask 2026-10-06). After a standby or a
 * replug the streamer's USB ids have moved, and the first thing that needs one (a
 * playlist, a favorite, Open in Library, Info, an agent's play) waits while the index is
 * moved onto the new ids and checked, or walked: about 20 s on the user's stick straight
 * after a wake, minutes on a big drive. A spinning Play button said "working" and nothing
 * said why, and from the palette or Search nothing showed at all. The index status marks
 * the server `waiting` once something has waited a second (a quick heal never flashes);
 * while any server is, one working toast says why, from wherever the act began, and it
 * goes when the wait ends unless a newer toast has replaced it.
 */
export function useDriveWaitToast(): void {
  useEffect(() => {
    let shown: number | null = null;
    const sync = (): void => {
      const st = useStore.getState();
      const waiting = st.mediaIndex.some((s) => s.waiting === true);
      if (waiting && shown == null) {
        st.showToast({ kind: "working", text: TEXT });
        shown = useStore.getState().toast?.id ?? null;
      } else if (!waiting && shown != null) {
        if (useStore.getState().toast?.id === shown) useStore.getState().dismissToast();
        shown = null;
      }
    };
    sync();
    // only an index change can start or end a wait (the toast's own write must not re-enter)
    return useStore.subscribe((state, prev) => {
      if (state.mediaIndex !== prev.mediaIndex) sync();
    });
  }, []);
}
