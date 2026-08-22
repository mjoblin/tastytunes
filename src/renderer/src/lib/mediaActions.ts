import { presetVolumeKey } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { refToContentRef, type MediaRef } from "@/lib/mediaRef";

// Shared verbs over MediaRef — the same fast-path-then-content-resolve
// discipline everywhere: stored serverUdn/objectId are HINTS that rot, content
// identity is what actually finds things (the standing rule from favorites,
// playlists and queue undo). Failures toast here, so no surface can wire a
// button that silently does nothing.

/** Resolve a ref to a playable (server, object) pair, hints first. Track-only
 *  on the resolve path — contentResolve finds items, not containers. */
async function resolveRef(ref: MediaRef): Promise<{ serverUdn: string; objectId: string } | null> {
  if (ref.serverUdn && ref.objectId) return { serverUdn: ref.serverUdn, objectId: ref.objectId };
  return tt.contentResolve(refToContentRef(ref)).catch(() => null);
}

/** Play a track now. True if the command landed; failures are toasted. */
export async function playRefNow(ref: MediaRef): Promise<boolean> {
  const showToast = useStore.getState().showToast;
  if (ref.serverUdn && ref.objectId) {
    try {
      await tt.mediaQueueAdd(ref.serverUdn, ref.objectId, "PLAY_NOW");
      return true;
    } catch {
      // rotted hint — fall through to the content resolve
    }
  }
  const found = await tt.contentResolve(refToContentRef(ref)).catch(() => null);
  if (!found) {
    showToast({ kind: "error", text: `Couldn't find “${ref.title}” on any server` });
    return false;
  }
  try {
    await tt.mediaQueueAdd(found.serverUdn, found.objectId, "PLAY_NOW");
    return true;
  } catch {
    showToast({ kind: "error", text: `Couldn't play “${ref.title}”` });
    return false;
  }
}

/**
 * The bookkeeping every preset save shares once the device write landed:
 * optional rename, the local artist record (settings.presetArtists —
 * /presets/list has no artist field, this is what lets the Presets filter
 * match by artist), and the toast with the way to the effect. Split out so
 * surfaces with their own resolution (favorites' favoriteAct healing) finish
 * identically to the plain path.
 */
export async function recordPresetSaved(
  ref: MediaRef,
  slot: number,
  name: string | null,
): Promise<void> {
  if (name) await tt.command({ type: "presetRename", slot, name });
  const s = useStore.getState();
  if (ref.artist) {
    void s.saveSettings({
      presetArtists: {
        ...s.settings.presetArtists,
        [presetVolumeKey(s.systemInfo?.udn, slot)]: ref.artist,
      },
    });
  }
  s.showToast({
    kind: "success",
    text: `Saved “${name ?? ref.title}” to preset ${slot}`,
    action: { label: "View", screen: "presets" },
  });
}

/**
 * Save a ref to a device preset slot. Throws on failure — PresetSavePanel's
 * contract (the panel stays open when the save didn't land).
 */
export async function saveRefToPreset(
  ref: MediaRef,
  slot: number,
  name: string | null,
): Promise<void> {
  const showToast = useStore.getState().showToast;
  const target = await resolveRef(ref);
  if (!target) {
    showToast({ kind: "error", text: `Couldn't find “${ref.title}” to save` });
    throw new Error("preset save failed");
  }
  try {
    await tt.mediaPresetSave(target.serverUdn, target.objectId, slot);
  } catch {
    showToast({ kind: "error", text: "Couldn't save the preset" });
    throw new Error("preset save failed");
  }
  await recordPresetSaved(ref, slot, name);
}
