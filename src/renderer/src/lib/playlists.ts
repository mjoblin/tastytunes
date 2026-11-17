import {
  type Playlist,
  type PlaylistActivation,
  type PlaylistItem,
  withoutAppended,
} from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";

/**
 * Activate a playlist — replace the streamer's queue with it — and TELL the
 * user how it went.
 *
 * Shared by the Playlists screen and unified search (the lib/recents pattern:
 * one helper so the outcome reporting can't belong to only one surface). The
 * reporting is the point of the wrapper. Activation replaces the QUEUE — an
 * effect you can't see from either surface — so the outcome toasts with a way
 * there; and rejections (not connected, a run already going, a mid-run network
 * failure) don't ride the command() path, so the api layer's central failure
 * toast never sees them — the catch here is that toast's stand-in. Search
 * originally called tt.playlistActivate with a bare `.catch(() => {})`, which
 * was a Play button that could silently do nothing.
 */
export async function activatePlaylist(p: { id: string; name: string }): Promise<void> {
  const showToast = useStore.getState().showToast;
  let res: PlaylistActivation;
  try {
    res = await tt.playlistActivate(p.id);
  } catch {
    showToast({ kind: "error", text: `Couldn't load “${p.name}”` });
    return;
  }
  const missed = res.missed.length;
  showToast({
    kind: res.added > 0 ? "success" : "error",
    text: res.cancelled
      ? `Stopped. ${res.added} of ${res.total} tracks loaded.`
      : missed > 0
        ? `Loaded ${res.added} of ${res.total} tracks. ${missed} ${missed === 1 ? "wasn't" : "weren't"} found.`
        : `Loaded ${res.added} ${res.added === 1 ? "track" : "tracks"} from “${p.name}”`,
    action: { label: "Open Queue", screen: "queue" },
  });
}

/**
 * THE UNDO OF A CREATE OR AN ADD UNDOES ONLY THAT. An undo of a create deletes the playlist only
 * while it is as it was made: once it has been renamed, reordered or added to, the undo keeps it
 * and says so (deleting it would take the edits too, with no undo of its own). An undo of an add
 * takes out what the add appended (withoutAppended), keeping every edit made since.
 */
export function pushCreatePlaylistUndo(created: Playlist): void {
  useStore.getState().pushUndo(`Create Playlist “${created.name}”`, () => {
    const now = useStore.getState().playlists.find((p) => p.id === created.id);
    if (!now) return;
    if (now.updatedAt !== created.updatedAt)
      return { refused: `Kept “${now.name}”, which changed after it was made.` };
    void tt.playlistDelete(created.id);
  });
}

export function pushAddToPlaylistUndo(id: string, name: string, added: PlaylistItem[]): void {
  const n = added.length;
  useStore
    .getState()
    .pushUndo(`Add ${n} ${n === 1 ? "Track" : "Tracks"} to Playlist “${name}”`, () => {
      const now = useStore.getState().playlists.find((p) => p.id === id);
      if (now) void tt.playlistSetItems(id, withoutAppended(now.items, added));
    });
}
