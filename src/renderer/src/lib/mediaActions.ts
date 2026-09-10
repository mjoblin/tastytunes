import { presetVolumeKey, type MediaNode } from "@shared/model";
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

/**
 * Open a ref's place in the Library: an album lands on itself, a track lands
 * on its ALBUM with the track scrolled to and flashed (2026-08-23, user ask —
 * every list that holds a ref can now lead back to where it came from:
 * favorites, queue, playlists, recents, the Info modal). Content-resolved
 * through the library index (mediaNodeInfo), hints first; the album is the
 * resolved track's parent container, or the index's album by title when a
 * server gives tracks no parent. True if the Library was pointed somewhere;
 * a miss toasts and leaves you where you are.
 */
/** Land the Library on an ARTIST by name: the Artists lens at the root, the
 *  artist selected and revealed near the top — the Tracks lens's own link,
 *  reachable from every row that shows a name since 2026-09-02 (NameLine). */
export function openArtistInLibrary(artist: string): void {
  useStore.getState().openArtistInLibrary(artist);
}

export async function openRefInLibrary(ref: MediaRef): Promise<boolean> {
  const s = useStore.getState();
  const miss = (): false => {
    s.showToast({ kind: "error", text: `Couldn't find “${ref.title}” in the library` });
    return false;
  };
  if (ref.kind !== "track" && ref.kind !== "album") return miss();
  const info = await tt
    .mediaNodeInfo({ kind: ref.kind, title: ref.title, artist: ref.artist, album: ref.album })
    .catch(() => null);
  const node = info?.node;
  if (!node?.serverUdn) return miss();
  if (ref.kind === "album") {
    s.openInLibrary({
      serverUdn: node.serverUdn,
      objectId: node.id,
      titlePath: [node.title],
      title: node.title,
    });
    return true;
  }
  const albumTitle = node.album ?? ref.album ?? null;
  if (!albumTitle) return miss();
  // The ALBUM comes from the index's albums pool, never from the track's
  // parentId: a search-built index carries the SEARCH SCOPE as every track's
  // parent — on Asset that is the library-wide "Title" view, 4,551 children —
  // and landing there showed the whole library under the album's name (user,
  // 2026-08-23). The parent is only the fallback for a server whose index has
  // no album entity for this track (folder-only libraries).
  const album = await tt
    .mediaNodeInfo({ kind: "album", title: albumTitle, artist: node.albumArtist ?? ref.artist })
    .catch(() => null);
  // …and it must actually HOLD the track: a title shared by two albums
  // ("Greatest Hits") with the album artist unknown could resolve to the
  // other artist's album (2026-08-23 hardening). The index lists an album's
  // tracks; when it does and ours isn't among them, the parent is the better
  // bet, and a parent that is the search scope is caught by the miss toast
  // rather than by landing on the whole library — see the parentId note.
  const holds = (tracks: MediaNode[] | undefined): boolean =>
    tracks == null ||
    tracks.some(
      (t) =>
        t.title === node.title &&
        (t.durationSecs == null ||
          node.durationSecs == null ||
          Math.abs(t.durationSecs - node.durationSecs) <= 2),
    );
  const albumId =
    album?.node.isContainer && album.node.serverUdn === node.serverUdn && holds(album.tracks)
      ? album.node.id
      : node.parentId;
  if (!albumId) return miss();
  s.openInLibrary({
    serverUdn: node.serverUdn,
    objectId: albumId,
    titlePath: [albumTitle],
    title: albumTitle,
    track: node.title,
  });
  return true;
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

/** Queue a track by ref — play next, append, or replace — hints first, then
 *  content; failures toast (the write-verb rule). */
export async function queueRef(
  ref: MediaRef,
  action: "PLAY_NEXT" | "APPEND" | "REPLACE",
): Promise<boolean> {
  const showToast = useStore.getState().showToast;
  if (ref.serverUdn && ref.objectId) {
    try {
      await tt.mediaQueueAdd(ref.serverUdn, ref.objectId, action);
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
    await tt.mediaQueueAdd(found.serverUdn, found.objectId, action);
    return true;
  } catch {
    showToast({ kind: "error", text: `Couldn't queue “${ref.title}”` });
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
