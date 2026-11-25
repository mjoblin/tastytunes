// THE SEARCH RESULTS, lifted out of LibraryScreen (0.15.0, the screen's split, round B: its
// views): one library's search and the search across libraries alike, one windowed list of lines,
// and from the keyboard one Tab stop across them. Always rendered, so its windowing and its keyed
// spot live as long as the screen does (a result entered and the query crumb back find the list
// as it was); it draws nothing until there are results to show. The item wiring is the screen's.
import { useCallback, useMemo, useRef, useState } from "react";
import { HardDrive, Usb } from "lucide-react";
import type { MediaNode, MediaServerInfo } from "@shared/model";
import { cx } from "@/lib/format";
import { keyedEvent } from "@/lib/menuAt";
import { isAlbumClass } from "@/lib/media";
import { useWindowedList } from "@/hooks/useWindowedList";
import { ListKeysContext, useListKeys } from "@/hooks/useListKeys";
import { searchStep, type SearchSpot } from "@/components/library/searchKeys";
import type { useLibrarySearch } from "@/components/library/useLibrarySearch";
import type { useLibraryMenus } from "@/components/library/useLibraryMenus";
import type { useLibrarySelection } from "@/components/library/useLibrarySelection";
import type { useQueueMatch } from "@/components/library/useQueueMatch";
import type { ContainerItem, TrackRowOf } from "@/components/library/LibraryListing";

/** One line of the windowed search results (see searchLines): every kind has one height. */
type SearchLine =
  | {
      kind: "group0" | "group";
      key: string;
      group: { udn: string; serverName: string; total: number };
    }
  | { kind: "label0" | "label" | "klabel"; key: string; text: string }
  | { kind: "cards0" | "cards"; key: string; nodes: MediaNode[] }
  | { kind: "crow" | "track"; key: string; node: MediaNode; list: MediaNode[]; index: number };

/** One library's results across libraries, by kind (the screen's crossGroups). */
export interface CrossGroup {
  udn: string;
  serverName: string;
  total: number;
  albums: MediaNode[];
  artists: MediaNode[];
  folders: MediaNode[];
  tracks: MediaNode[];
}

type Search = ReturnType<typeof useLibrarySearch>;

export function LibrarySearchResults({
  shown,
  scrollRef,
  crossMode,
  crossState,
  crossGroups,
  searchMode,
  searchState,
  containers,
  tracks,
  cards,
  presetCardSize,
  presetGap,
  presetFillRows,
  servers,
  enter,
  trackRowClick,
  playTrack,
  openMenu,
  containerItem,
  trackRow,
}: {
  /** A library's search, or the search across libraries, has its results in. */
  shown: boolean;
  scrollRef: { current: HTMLDivElement | null };
  crossMode: boolean;
  crossState: Search["crossState"];
  crossGroups: CrossGroup[];
  searchMode: boolean;
  searchState: Search["searchState"];
  /** One library's results, as the listing sorted and filtered them. */
  containers: MediaNode[];
  tracks: MediaNode[];
  cards: boolean;
  presetCardSize: number;
  presetGap: number;
  presetFillRows: boolean;
  servers: MediaServerInfo[] | null;
  enter(node: MediaNode): void;
  trackRowClick: ReturnType<typeof useLibrarySelection>["trackRowClick"];
  playTrack: ReturnType<typeof useQueueMatch>["playTrack"];
  openMenu: ReturnType<typeof useLibraryMenus>["openMenu"];
  containerItem: ContainerItem;
  trackRow: TrackRowOf;
}): React.JSX.Element | null {
  // ONE WINDOWED LIST OF EVERY RESULT (the 500-at-a-time button sat at the end of the first
  // library's group, mid-list): the results flatten into lines (a library's heading, a kind's
  // label, a row of cards, a container row, a track row), and only the lines near the viewport
  // are drawn, the Albums grid's rule. Each line carries its own spacing inside it (padding, a
  // border on every row, transparent on a section's first), so a kind of line has one height
  // to measure.
  const [searchWidth, setSearchWidth] = useState(0);
  const searchRo = useRef<ResizeObserver | null>(null);
  const searchBodyRef = useCallback((el: HTMLDivElement | null) => {
    searchRo.current?.disconnect();
    searchRo.current = null;
    if (!el) return;
    setSearchWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setSearchWidth(e.contentRect.width));
    ro.observe(el);
    searchRo.current = ro;
  }, []);
  const searchCols = Math.max(
    1,
    Math.floor((searchWidth + presetGap) / (presetCardSize + presetGap)),
  );
  const searchLines = useMemo((): SearchLine[] => {
    const lines: SearchLine[] = [];
    const section = (key: string, text: string, list: MediaNode[], containers: boolean): void => {
      if (list.length === 0) return;
      // across libraries a kind's label sits tight under its library's heading
      const label = crossMode ? "klabel" : lines.length === 0 ? "label0" : "label";
      lines.push({ kind: label, key: `${key}-l`, text });
      if (containers && cards) {
        for (let i = 0; i < list.length; i += searchCols)
          lines.push({
            kind: i === 0 ? "cards0" : "cards",
            key: `${key}-c${i}`,
            nodes: list.slice(i, i + searchCols),
          });
      } else
        list.forEach((node, index) =>
          lines.push({
            kind: containers ? "crow" : "track",
            key: `${key}-${node.id}`,
            node,
            list,
            index,
          }),
        );
    };
    const kinds = (key: string, items: MediaNode[], tracksOf: MediaNode[]): void => {
      section(
        `${key}a`,
        "Artists",
        items.filter((c) => c.isContainer && c.upnpClass.includes("musicArtist")),
        true,
      );
      section(
        `${key}b`,
        "Albums",
        items.filter((c) => c.isContainer && isAlbumClass(c.upnpClass)),
        true,
      );
      section(
        `${key}f`,
        "Folders",
        items.filter(
          (c) =>
            c.isContainer && !isAlbumClass(c.upnpClass) && !c.upnpClass.includes("musicArtist"),
        ),
        true,
      );
      section(`${key}t`, "Tracks", tracksOf, false);
    };
    if (crossMode && crossState)
      crossGroups.forEach((g) => {
        lines.push({ kind: lines.length === 0 ? "group0" : "group", key: `g-${g.udn}`, group: g });
        kinds(`g-${g.udn}-`, [...g.artists, ...g.albums, ...g.folders], g.tracks);
      });
    else if (searchMode && searchState) kinds("s-", containers, tracks);
    return lines;
  }, [
    crossMode,
    crossState,
    crossGroups,
    searchMode,
    searchState,
    containers,
    tracks,
    cards,
    searchCols,
  ]);
  const searchKinds = useMemo(() => searchLines.map((l) => l.kind), [searchLines]);
  const searchWin = useWindowedList({
    scrollRef,
    count: searchLines.length,
    itemSelector: "[data-search-line]",
    kinds: searchKinds,
    estimate: {
      group0: 36,
      group: 56,
      label0: 30,
      label: 42,
      klabel: 30,
      cards0: presetCardSize + 60,
      cards: presetCardSize + 52 + presetGap,
      crow: 57,
      track: 57,
    },
    overscan: 6,
    enabled: searchLines.length > 80,
  });
  // FROM THE KEYBOARD (0.14.0): the search results one Tab stop across their
  // windowed lines, a kind's cards a grid and its rows a column (components/library/searchKeys);
  // Enter opens a result or plays a track as its click does, "." its More menu
  const { searchSpots, firstOfLine } = useMemo(() => {
    const spots: Array<SearchSpot & { node: MediaNode; list: MediaNode[] | null }> = [];
    const first: number[] = [];
    let section = -1;
    searchLines.forEach((l, line) => {
      first.push(spots.length);
      if ("text" in l) section++;
      else if ("nodes" in l)
        l.nodes.forEach((node, col) =>
          spots.push({ line, col, card: true, section, node, list: null }),
        );
      else if ("node" in l)
        spots.push({
          line,
          col: 0,
          card: false,
          section,
          node: l.node,
          list: l.kind === "track" ? l.list : null,
        });
    });
    return { searchSpots: spots, firstOfLine: first };
  }, [searchLines]);
  const searchKeys = useListKeys({
    count: searchSpots.length,
    step: (key, at) => searchStep(key, at, searchSpots),
    onEnter: (i, el) => {
      const r = searchSpots[i];
      if (!r) return;
      if (!r.list) enter(r.node);
      else if (!trackRowClick(r.node, keyedEvent(el))) playTrack(r.node, el);
    },
    onMenu: (i, el) => {
      const r = searchSpots[i];
      if (r) openMenu(r.node, keyedEvent(el), r.list ?? undefined);
    },
    reveal: (i) => {
      const r = searchSpots[i];
      const sc = scrollRef.current;
      if (r && sc) sc.scrollTop = Math.max(0, searchWin.offsetOf(r.line) - sc.clientHeight / 3);
    },
  });
  const searchKeysRef = searchKeys.container.ref;
  const searchListRef = useCallback(
    (el: HTMLDivElement | null) => {
      searchBodyRef(el);
      searchKeysRef(el);
    },
    [searchBodyRef, searchKeysRef],
  );

  /** One line of the windowed search results; its spacing lives inside it (see searchLines). */
  const searchLine = (line: SearchLine, li: number): React.JSX.Element => {
    const attrs = { "data-search-line": "", "data-win-kind": line.kind };
    // the line's first result in the keyed list (searchSpots)
    const at = firstOfLine[li];
    if ("group" in line) {
      const src = servers?.find((x) => x.udn === line.group.udn);
      return (
        <div
          key={line.key}
          {...attrs}
          data-cross-server-group={line.group.serverName}
          className={cx("flex items-center gap-2 px-1", line.kind === "group0" ? "pt-2" : "pt-7")}
        >
          {src?.isStreamer ? (
            <Usb size={15} className="text-dim" />
          ) : (
            <HardDrive size={15} className="text-dim" />
          )}
          <span className="text-[13.5px] font-medium">{line.group.serverName}</span>
          <span className="font-mono text-[11px] text-faint tabular-nums">
            {line.group.total} result{line.group.total === 1 ? "" : "s"}
          </span>
        </div>
      );
    }
    if ("text" in line)
      return (
        <div
          key={line.key}
          {...attrs}
          className={cx("microlabel pb-0.5 px-1", line.kind === "label" ? "pt-5" : "pt-2")}
        >
          {line.text}
        </div>
      );
    if ("nodes" in line)
      return (
        <div
          key={line.key}
          {...attrs}
          style={{
            display: "grid",
            gridTemplateColumns: presetFillRows
              ? `repeat(${searchCols}, minmax(${presetCardSize}px, 1fr))`
              : `repeat(${searchCols}, ${presetCardSize}px)`,
            gap: presetGap,
            paddingTop: line.kind === "cards0" ? 8 : presetGap,
          }}
        >
          {line.nodes.map((node, col) => containerItem(node, searchKeys.item(at + col)))}
        </div>
      );
    // a row: its divider is its own top border, transparent on a section's first
    return (
      <div
        key={line.key}
        {...attrs}
        className={cx("-mx-3 border-t", line.index === 0 ? "border-transparent" : "border-edge/50")}
      >
        {line.kind === "crow"
          ? containerItem(line.node, searchKeys.item(at))
          : trackRow(line.node, line.list, line.index, {
              showArt: true,
              links: true,
              item: searchKeys.item(at),
            })}
      </div>
    );
  };

  if (!shown || searchLines.length === 0) return null;
  return (
    <div
      {...searchKeys.container}
      ref={searchListRef}
      aria-label="Search results"
      data-search-list
      style={{ overflowAnchor: "none" }}
    >
      <ListKeysContext.Provider value={true}>
        {searchWin.padTop > 0 && <div style={{ height: searchWin.padTop }} />}
        {searchLines
          .slice(searchWin.first, searchWin.last + 1)
          .map((l, k) => searchLine(l, searchWin.first + k))}
        {searchWin.padBottom > 0 && <div style={{ height: searchWin.padBottom }} />}
      </ListKeysContext.Provider>
    </div>
  );
}
