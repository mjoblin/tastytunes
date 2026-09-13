import { useEffect, useMemo, useRef, useState } from "react";
import { useRowSelection } from "@/components/library/useRowSelection";
import type { MediaNode } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { useNavDrag } from "@/hooks/useNavDrag";
import { flashNavTarget } from "@/lib/navDrop";
import type { Lens } from "@/components/library/lensNavigation";
import type { Crumb } from "@/screens/LibraryScreen";

// The Library's SELECTION AND DRAG, lifted out of LibraryScreen (2026-09-13,
// the third lift of the screen's hygiene round, after search mode and the
// menus): the multi-select over the visible track rows and its keyboard, the
// batch queue writes with their undo, and the drag to the nav with the Finder
// payload rule. The screen keeps the rows, the selection bar and the queue
// actions, and takes the state back under the old names.

/** What the selection reads that the screen derives after the hook runs (the
 *  hearts): reached late-bound, read at event time, never captured. */
export interface SelectionLate {
  heartNode(node: MediaNode): void;
  heartNodes(nodes: MediaNode[], allIn: boolean): void;
  nodeFavorited(node: MediaNode): boolean;
}

export function useLibrarySelection(d: {
  serverUdn: string | null;
  path: Crumb[];
  lens: Lens | null;
  searchMode: boolean;
  atRoot: boolean;
  state: "loading" | "ready" | "error";
  /** The visible track listing, in order (the screen derives it before the
   *  hook since step two of the lenses round, so the selection's survivors
   *  and its ⌘A read it directly). */
  tracks: MediaNode[];
  nodeUdn(node: MediaNode): string | null;
  showToast: ReturnType<typeof useStore.getState>["showToast"];
  showNotice(msg: string): void;
  /** One wording for a queue write that didn't land (the screen's). */
  queueFailed: string;
  setPlaylistPicker(picker: { node: MediaNode; x: number; y: number } | null): void;
  late: { current: SelectionLate };
}) {
  const { serverUdn, path, lens, searchMode, atRoot, state, tracks, nodeUdn } = d;
  const { showToast, showNotice, queueFailed, late } = d;
  // Multi-select over the visible track rows (2026-08-24): the row grammar
  // from useRowSelection (one home since 2026-09-13) over the listing's ids;
  // ⌘A yields to an open lens, the root and a listing not ready.
  const keys = useMemo(() => tracks.map((n) => n.id), [tracks]);
  const {
    selected: selTracks,
    setSelected: setSelTracks,
    rowClick,
  } = useRowSelection({ keys, canSelectAll: lens == null && !atRoot && state === "ready" });
  const [playlistMulti, setPlaylistMulti] = useState<{
    nodes: MediaNode[];
    x: number;
    y: number;
    /** The invoking surface's selection-clear, run only when a target was
     *  picked (cancel keeps the selection — the bar rule). */
    clear?(): void;
    /** An unselected row dragged alone: its drop must not clear a selection
     *  it never carried (the Finder rule). */
    keepSelection?: boolean;
  } | null>(null);

  // the batch playlist panel closes whenever the listing changes under it
  // (the selection itself keeps its survivors, the core's rule)
  useEffect(() => {
    setPlaylistMulti(null);
  }, [serverUdn, path, lens, searchMode]);

  /** True = the click was a selection chord; the caller must not play. */
  const trackRowClick = (node: MediaNode, e: React.MouseEvent): boolean => rowClick(node.id, e);
  const selectedNodes = (): MediaNode[] => tracks.filter((n) => selTracks.has(n.id));
  /** The selection bar's queue verbs, in the visible order. PLAY_NEXT inserts
   *  after the current track, so batches go in reversed to land in order. */
  /** Queue a batch of track nodes — the ONE implementation behind the main
   *  listing's bar and the lens column's (chosen arrives in visible order;
   *  PLAY_NEXT inserts reversed so the batch lands in order). Resolves true
   *  when the writes landed, so callers clear their selection only then. */
  const queueNodes = async (
    chosen: MediaNode[],
    mode: "now" | "next" | "append" | "replace",
  ): Promise<boolean> => {
    if (chosen.length === 0) return false;
    // The undo identity: device-assigned queue ids snapshotted before the
    // writes — after the re-announce, the added entries are exactly the ids
    // that were not there. (Play now is deliberately not undoable: its
    // inverse is not a removal, it would yank the playing track.)
    const beforeIds = new Set(
      ((await tt.getSnapshot()).queue?.items ?? []).flatMap((i) => (i.id != null ? [i.id] : [])),
    );
    try {
      if (mode === "now") {
        await tt.mediaQueueAdd(nodeUdn(chosen[0]) ?? "", chosen[0].id, "PLAY_NOW");
        for (const n of [...chosen.slice(1)].reverse())
          await tt.mediaQueueAdd(nodeUdn(n) ?? "", n.id, "PLAY_NEXT");
      } else if (mode === "replace") {
        // the album Play button's semantics for a chosen list: the first
        // track replaces the queue and starts, the rest follow in order.
        // Tier 2 like Replace queue — a whole-queue restore is not offered.
        await tt.mediaQueueAdd(nodeUdn(chosen[0]) ?? "", chosen[0].id, "REPLACE");
        for (const n of chosen.slice(1)) await tt.mediaQueueAdd(nodeUdn(n) ?? "", n.id, "APPEND");
      } else if (mode === "next") {
        for (const n of [...chosen].reverse())
          await tt.mediaQueueAdd(nodeUdn(n) ?? "", n.id, "PLAY_NEXT");
      } else {
        for (const n of chosen) await tt.mediaQueueAdd(nodeUdn(n) ?? "", n.id, "APPEND");
      }
      if (mode === "next" || mode === "append") {
        showToast({ kind: "success", text: `Added ${chosen.length} tracks to the queue` });
        void armQueueAddUndo(beforeIds, chosen.length, mode);
      }
      return true;
    } catch {
      showNotice(queueFailed);
      return false;
    }
  };
  /** Wait for the re-announce, identify the landed entries by id, and arm
   *  the undo. Skipped honestly when the count is ambiguous (another
   *  controller added in the same window). */
  const armQueueAddUndo = async (
    beforeIds: ReadonlySet<number>,
    count: number,
    mode: "next" | "append",
  ): Promise<void> => {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const items = (await tt.getSnapshot()).queue?.items ?? [];
      const added = items.flatMap((it) => (it.id != null && !beforeIds.has(it.id) ? [it.id] : []));
      if (added.length < count) continue;
      if (added.length > count) return;
      useStore
        .getState()
        .pushUndo(
          mode === "append"
            ? `Add ${count} ${count === 1 ? "Track" : "Tracks"} to Queue`
            : `Play ${count} ${count === 1 ? "Track" : "Tracks"} Next`,
          async () => {
            for (const id of added) await tt.command({ type: "queueDelete", id });
          },
        );
      return;
    }
  };

  const queueSelected = async (mode: "now" | "next" | "append"): Promise<void> => {
    if (await queueNodes(selectedNodes(), mode)) setSelTracks(new Set());
  };

  // Drag-to-rail: ANY track row drags onto Queue, Playlists or Favorites in
  // the nav — the Finder rule decides the payload: a selected row carries
  // the whole selection, an unselected row carries itself alone and leaves
  // the selection untouched. Queue appends (the bar verb's semantics),
  // Favorites ADDS what's missing (a drop is additive intent), Playlists
  // opens the batch panel at the release point.
  const dragCargo = useRef<{
    nodes: MediaNode[];
    fromSelection: boolean;
    /** Album cargo (2026-09-02): the ordered containers and the chip's title. */
    albums?: { title: string; noun?: string };
  }>({
    nodes: [],
    fromSelection: false,
  });
  const navDrag = useNavDrag({
    targets: ["queue", "playlists", "favorites"],
    payload: () => {
      const { nodes, albums } = dragCargo.current;
      if (nodes.length === 0) return null;
      if (albums)
        return {
          count: nodes.length,
          title: albums.title,
          artUrl: nodes[0].artUrl,
          noun: albums.noun ?? (nodes.length === 1 ? "album" : "volumes"),
          artKind: "album" as const,
        };
      return { count: nodes.length, title: nodes[0].title };
    },
    onDrop: (target, at) => {
      const { nodes, fromSelection, albums } = dragCargo.current;
      if (albums) {
        // ALBUMS drop with the meanings of the album's own menu verbs: Queue =
        // Add to end of queue (each volume of a set in order), Favorites = the
        // tile's heart (volume 1 of a set, added not toggled), Playlists = Add
        // to playlist… (the album expanded to tracks first; a set's volumes
        // expanded in order). Single album per drag, by design.
        if (target === "queue") {
          void queueNodes(nodes, "append").then((ok) => {
            if (ok) flashNavTarget("queue");
          });
        } else if (target === "favorites") {
          if (fromSelection) late.current.heartNodes(nodes, false);
          else if (!late.current.nodeFavorited(nodes[0])) late.current.heartNode(nodes[0]);
          flashNavTarget("favorites");
        } else if (target === "playlists") {
          if (nodes.length === 1) d.setPlaylistPicker({ node: nodes[0], x: at.x, y: at.y });
          else
            void expandVolumes(nodes).then((tracks) =>
              setPlaylistMulti({ nodes: tracks, x: at.x, y: at.y }),
            );
        }
        return;
      }
      if (target === "queue") {
        void queueNodes(nodes, "append").then((ok) => {
          if (ok) {
            if (fromSelection) setSelTracks(new Set());
            flashNavTarget("queue");
          }
        });
      } else if (target === "favorites") {
        late.current.heartNodes(nodes, false);
        flashNavTarget("favorites");
      } else if (target === "playlists") {
        setPlaylistMulti({ nodes, x: at.x, y: at.y, keepSelection: !fromSelection });
      }
    },
  });
  /** A box set's volumes, expanded to their tracks in volume order (the
   *  playlist panel stores tracks, never container references). */
  const expandVolumes = async (volumes: MediaNode[]): Promise<MediaNode[]> => {
    const out: MediaNode[] = [];
    for (const v of volumes) {
      const udn = nodeUdn(v);
      if (!udn) continue;
      const kids = await tt.mediaBrowse(udn, v.id, []).catch(() => [] as MediaNode[]);
      out.push(...kids.filter((c) => !c.isContainer));
    }
    return out;
  };
  const startAlbumDrag = (
    nodes: MediaNode[],
    e: React.PointerEvent,
    title: string,
    noun?: string,
  ): void => {
    // a multi-album selection (0.8.0) is a selection: every album hearts on the
    // Favorites drop, where a box set hearts volume 1 alone
    dragCargo.current = { nodes, fromSelection: noun === "albums", albums: { title, noun } };
    navDrag.start(e);
  };
  const startTrackDrag = (node: MediaNode, e: React.PointerEvent): void => {
    const fromSelection = selTracks.has(node.id);
    dragCargo.current = {
      nodes: fromSelection ? selectedNodes() : [node],
      fromSelection,
      albums: undefined,
    };
    navDrag.start(e);
  };

  return {
    selTracks,
    setSelTracks,
    playlistMulti,
    setPlaylistMulti,
    trackRowClick,
    selectedNodes,
    queueNodes,
    queueSelected,
    navDrag,
    startAlbumDrag,
    startTrackDrag,
  };
}
