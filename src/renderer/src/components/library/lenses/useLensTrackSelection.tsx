import { useMemo, useRef, useState } from "react";
import { Heart, ListEnd, ListPlus, ListStart, Play } from "lucide-react";
import type { MediaNode } from "@shared/model";
import { useNavDrag } from "@/hooks/useNavDrag";
import { flashNavTarget } from "@/lib/navDrop";
import { RowMenu } from "@/components/media/RowMenu";
import { SelectionBar, SelectionVerb } from "@/components/controls/SelectionBar";
import { useRowSelection } from "@/components/library/useRowSelection";
import { type LensActions, nodeKey } from "./lensShared";

// The track lenses' selection (2026-09-13, step two of the lenses round; the
// Artists and Tracks lenses carried two copies of all of it): the row grammar
// from useRowSelection over the tracks shown, the drag to the nav with the
// Finder payload rule, the plural ⋯ (a menu invoked ON a selected track
// speaks for the whole selection, the Finder/Spotify convention; unselected
// rows keep the single-track builder menu), and the five verbs the bar and
// that menu share. The lens renders its rows and places the bar.

export function useLensTrackSelection(d: { tracks: MediaNode[]; actions: LensActions }) {
  const { tracks, actions } = d;
  const keys = useMemo(() => tracks.map(nodeKey), [tracks]);
  const { selected: selT, setSelected: setSelT, rowClick } = useRowSelection({ keys });
  const clear = (): void => setSelT(new Set());
  /** True = the click was a selection chord; the caller must not play. */
  const trackRowClick = (t: MediaNode, e: React.MouseEvent): boolean => rowClick(nodeKey(t), e);
  const chosenT = (): MediaNode[] => tracks.filter((t) => selT.has(nodeKey(t)));

  // Drag-to-rail from the lens's track column — same targets and semantics
  // as the Library lists, routed through the actions the lens already has;
  // a selected row carries the whole selection, an unselected row carries
  // itself alone and leaves the selection untouched (the Finder rule)
  const dragCargo = useRef<{ nodes: MediaNode[]; fromSelection: boolean }>({
    nodes: [],
    fromSelection: false,
  });
  const navDrag = useNavDrag({
    targets: ["queue", "playlists", "favorites"],
    payload: () => {
      const { nodes } = dragCargo.current;
      if (nodes.length === 0) return null;
      return { count: nodes.length, title: nodes[0].title };
    },
    onDrop: (target, at) => {
      const { nodes, fromSelection } = dragCargo.current;
      if (target === "queue") {
        actions.queueTracks(nodes, "append", () => {
          if (fromSelection) clear();
          flashNavTarget("queue");
        });
      } else if (target === "favorites") {
        actions.heartNodes(nodes, false);
        flashNavTarget("favorites");
      } else if (target === "playlists") {
        actions.addTracksToPlaylist(nodes, at, fromSelection ? clear : undefined);
      }
    },
  });
  const startTrackDrag = (t: MediaNode, e: React.PointerEvent): void => {
    const fromSelection = selT.has(nodeKey(t));
    dragCargo.current = { nodes: fromSelection ? chosenT() : [t], fromSelection };
    navDrag.start(e);
  };

  const [lensMenu, setLensMenu] = useState<{ x: number; y: number } | null>(null);
  /** A row's ⋯: the plural menu when the row is one of several selected, the
   *  single-track builder menu otherwise. */
  const rowMenu = (t: MediaNode, e: React.MouseEvent): void => {
    if (selT.size > 1 && selT.has(nodeKey(t))) {
      e.preventDefault();
      e.stopPropagation();
      setLensMenu({ x: e.clientX, y: e.clientY });
    } else actions.openMenu(t, e);
  };
  /** The five verbs over the chosen tracks, in the bar and the plural menu
   *  alike; `at` is where a playlist panel opens. */
  const verbs = (): Array<{
    label: string;
    icon: React.ReactNode;
    run(at: { x: number; y: number }): void;
  }> => {
    const nodes = chosenT();
    const allIn = nodes.length > 0 && nodes.every(actions.nodeFavorited);
    return [
      {
        label: "Play now",
        icon: <Play size={13} />,
        run: () => actions.queueTracks(nodes, "now", clear),
      },
      {
        label: "Play next",
        icon: <ListStart size={13} />,
        run: () => actions.queueTracks(nodes, "next", clear),
      },
      {
        label: "Add to end of queue",
        icon: <ListEnd size={13} />,
        run: () => actions.queueTracks(nodes, "append", clear),
      },
      {
        label: "Add to playlist…",
        icon: <ListPlus size={13} />,
        run: (at) => actions.addTracksToPlaylist(nodes, at, clear),
      },
      {
        label: allIn ? "Remove from favorites" : "Add to favorites",
        icon: <Heart size={13} fill={allIn ? "currentColor" : "none"} />,
        run: () => actions.heartNodes(nodes, allIn),
      },
    ];
  };

  return {
    selT,
    setSelT,
    trackRowClick,
    chosenT,
    startTrackDrag,
    dragGhost: navDrag.ghost,
    rowMenu,
    lensMenu,
    setLensMenu,
    verbs,
  };
}

type LensTrackSelection = ReturnType<typeof useLensTrackSelection>;

/** The tracks column's bar — the one SelectionBar; the lens places it over
 *  its column (anchor geometry at the call site, the chrome-kit rule). */
export function LensTrackSelectionBar({
  sel,
  className,
}: {
  sel: LensTrackSelection;
  className: string;
}): React.JSX.Element | null {
  const { selT, setSelT } = sel;
  if (selT.size === 0) return null;
  return (
    <SelectionBar
      count={selT.size}
      onClear={() => setSelT(new Set())}
      className={className}
      data-lens-selection-bar
    >
      {sel.verbs().map((v) => (
        <SelectionVerb
          key={v.label}
          icon={v.icon}
          onClick={(e) => v.run({ x: e.clientX, y: e.clientY })}
        >
          {v.label}
        </SelectionVerb>
      ))}
    </SelectionBar>
  );
}

/** The plural ⋯ over the selection, at the row's click point. */
export function LensTrackMenu({ sel }: { sel: LensTrackSelection }): React.JSX.Element | null {
  const { lensMenu, setLensMenu, selT } = sel;
  if (!lensMenu) return null;
  return (
    <RowMenu
      at={lensMenu}
      title={`${selT.size} tracks`}
      onClose={() => setLensMenu(null)}
      items={sel.verbs().map((v) => ({ label: v.label, run: () => v.run(lensMenu) }))}
    />
  );
}
