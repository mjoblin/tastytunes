import { tt } from "@/api";
import { useStore } from "@/store";

/**
 * Clear the play history, offering to put it back.
 *
 * Shared by the two surfaces that offer it — the Recently Played header and the
 * Settings row — so the undo can't belong to only one of them.
 *
 * This was the largest single destruction of local data in the app and had
 * NEITHER a confirm nor an undo: one click, the whole log gone. It gets an undo
 * rather than a "Sure?" because the rollback is exact (one bounded local list),
 * and that's the standing rule — confirm guards what can't be undone, undo
 * covers what can (see restoreRecents for the merge that keeps it honest when
 * a track gets logged while the offer is up).
 */
/**
 * The Recent list's clear, as both its buttons ask it (the History screen's and Settings ›
 * History's): the whole list goes, so it confirms first (the destructive-edit rule: confirm for
 * whole collections, instant + undo for items; user, 2026-10-11: "the 'clear' button has no
 * affordance for 'Are you sure' which we have elsewhere in the app"), and the undo stays behind
 * the confirm.
 */
export const CLEAR_RECENTS = {
  question: "Clear the Recent list? The listening record is kept.",
  verb: "Clear",
  onConfirm: (): void => void clearRecentsWithUndo(),
};

export async function clearRecentsWithUndo(): Promise<void> {
  const { recents, showToast } = useStore.getState();
  if (recents.length === 0) return;
  const snapshot = recents;
  await tt.clearRecents();
  const undoId = useStore
    .getState()
    .pushUndo("Clear the Recent list", () => void tt.recentsRestore(snapshot));
  showToast({
    kind: "success",
    text: `Cleared ${snapshot.length} ${snapshot.length === 1 ? "entry" : "entries"}`,
    action: { label: "Undo", undo: () => useStore.getState().runUndo(undoId) },
  });
}
