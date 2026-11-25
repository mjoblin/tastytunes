// THE LIBRARY'S PLAY VERBS, lifted out of LibraryScreen (0.15.0, the screen's split, its hooks
// first): a queue write with its flash or its notice, Play on a container, Play album from here
// (the album's own browse supplies both ids), and Save as preset with the artist recorded beside
// it. The album shown is derived after the screen calls this; it arrives late-bound.
import {
  albumOfTrack,
  presetVolumeKey,
  trackPosition,
  type MediaIndexPools,
  type MediaNode,
  type MediaQueueAction,
} from "@shared/model";
import { nameKey } from "@shared/keys";
import { queueWrite, tt } from "@/api";
import { useStore } from "@/store";
import { flashTarget } from "@/lib/scroll";
import type { Crumb } from "@/components/library/libraryPlaces";

/** The queue actions that start the row playing: their acknowledgment is the playing ring. */
const STARTS_PLAYING: ReadonlySet<MediaQueueAction> = new Set([
  "PLAY_NOW",
  "PLAY_FROM_HERE",
  "REPLACE",
]);

/** One wording for a queue write that didn't land, whichever verb sent it. */
export const QUEUE_FAILED = "Couldn't reach the streamer. Nothing was queued.";

/** What the verbs read that the screen derives after calling the hook: the album shown and its
 *  artist (Save as preset records it). */
export interface PlayLate {
  albumNode: MediaNode | null;
  albumArtist: string | null;
}

export function useLibraryPlay(d: {
  nodeUdn(node: MediaNode): string | null;
  path: Crumb[];
  nodes: MediaNode[];
  lensPools: MediaIndexPools[] | null;
  showNotice(msg: string): void;
  setPresetPicker(picker: null): void;
  late: { current: PlayLate };
}) {
  const { nodeUdn, path, nodes, lensPools, showNotice, setPresetPicker } = d;
  const saveSettings = useStore((s) => s.saveSettings);
  const systemInfo = useStore((s) => s.systemInfo);
  const showToast = useStore((s) => s.showToast);

  const act = async (
    node: MediaNode,
    action: MediaQueueAction,
    el: HTMLElement | null,
    playFromId?: string,
  ): Promise<void> => {
    const udn = nodeUdn(node);
    if (!udn) return;
    const outcome = await queueWrite(() => tt.mediaQueueAdd(udn, node.id, action, playFromId));
    if (outcome === "failed") showNotice(QUEUE_FAILED);
    // the wash acknowledges an add (Play next, Add to queue), whose row nothing else marks; a play
    // is acknowledged by the playing ring the row is about to wear (0.16.0: the two together)
    else if (outcome === "ok" && el && !STARTS_PLAYING.has(action)) flashTarget(el);
  };

  /** "Play" on a container: replace the queue with it and start at its first track. */
  const playContainer = async (node: MediaNode, _el: HTMLElement | null): Promise<void> => {
    const udn = nodeUdn(node);
    if (!udn) return;
    const outcome = await queueWrite(async () => {
      const children = await tt.mediaBrowse(udn, node.id, [
        ...path.map((c) => c.title),
        node.title,
      ]);
      const firstTrack = children.find((c) => !c.isContainer);
      if (firstTrack) await tt.mediaQueueAdd(udn, node.id, "PLAY_FROM_HERE", firstTrack.id);
      else await tt.mediaQueueAdd(udn, node.id, "REPLACE");
    });
    // a played album wears the playing ring: no wash (as a played track, above)
    if (outcome === "failed") showNotice(QUEUE_FAILED);
  };

  /** "Play album from here" on a track: the album's OWN browse supplies both
   *  ids, the album view's contract (and the resume card's). A pooled or
   *  searched track's parentId is the search scope, the whole library on
   *  Asset, and its id belongs to that path: Play from here on it queued
   *  2,528 tracks (2026-09-04). A row of the album leaf on screen came from
   *  that browse and is used as it is. */
  const playAlbumFrom = async (track: MediaNode): Promise<void> => {
    const udn = nodeUdn(track);
    if (!udn) return;
    const leaf = path[path.length - 1];
    if (leaf && track.parentId === leaf.id && nodes.some((n) => n.id === track.id)) {
      await act({ ...track, id: leaf.id }, "PLAY_FROM_HERE", null, track.id);
      return;
    }
    const pools = lensPools ?? (await tt.mediaIndexPools().catch(() => null));
    const pool = pools?.find((g) => g.udn === udn);
    const album = pool ? albumOfTrack(track, pool) : null;
    const kids = album
      ? await tt.mediaBrowse(udn, album.id, [album.title]).catch(() => null)
      : null;
    const title = nameKey(track.title);
    const same = (kids ?? []).filter((k) => !k.isContainer && nameKey(k.title) === title);
    // twin titles on one album are real (a reprise): the position tells them apart
    const start = same.find((k) => trackPosition(k) === trackPosition(track)) ?? same[0];
    if (!album || !start) {
      showNotice(`Couldn't find "${track.album ?? "that album"}" in this library.`);
      return;
    }
    await act({ ...album, serverUdn: udn }, "PLAY_FROM_HERE", null, start.id);
  };

  // Throws on failure so the shared panel stays open; closes the picker itself
  // on success. A custom name rides along via presetRename (the firmware names
  // media presets from content otherwise).
  const savePreset = async (node: MediaNode, slot: number, name: string | null): Promise<void> => {
    const udn = nodeUdn(node);
    if (!udn) return;
    try {
      await tt.mediaPresetSave(udn, node.id, slot);
      if (name) await tt.command({ type: "presetRename", slot, name });
    } catch {
      showNotice("Couldn't save the preset.");
      throw new Error("preset save failed");
    }
    // Record the artist locally (settings.presetArtists): /presets/list has
    // no artist field and firmware-derived names are just the album title —
    // this is what lets the Presets filter match by artist. Read fresh so
    // back-to-back saves can't clobber each other's keys.
    const { albumNode, albumArtist } = d.late.current;
    const artist = node === albumNode ? (albumArtist ?? node.artist) : node.artist;
    if (artist) {
      void saveSettings({
        presetArtists: {
          ...useStore.getState().settings.presetArtists,
          [presetVolumeKey(systemInfo?.udn, slot)]: artist,
        },
      });
    }
    setPresetPicker(null);
    // unlike queue-adds there's no in-place flash — the effect lives on Presets
    showToast({
      kind: "success",
      text: `Saved “${name ?? node.title}” to preset ${slot}`,
      action: { label: "View", screen: "presets" },
    });
  };

  return { act, playContainer, playAlbumFrom, savePreset };
}
