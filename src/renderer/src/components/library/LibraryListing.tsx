// THE BROWSED LEVEL'S FOLDERS AND TRACKS, lifted out of LibraryScreen (0.15.0, the screen's
// split, round B: its views): a level's containers as one keyed grid or column (an artist's folder
// labelled by kind), and its tracks as one keyed column (an album's in disc groups). The item
// wiring, a container's card or row and a track's row, stays the screen's and comes in, so a
// browsed item, a lens's and a search result are the one row.
import type { MediaNode } from "@shared/model";
import { discGroups, performerLine } from "@shared/model";
import { cx } from "@/lib/format";
import { keyedEvent } from "@/lib/menuAt";
import { isAlbumClass, isArtistClass } from "@/lib/media";
import { KeyedList } from "@/components/controls/KeyedList";
import type { ListItemAttrs } from "@/hooks/useListKeys";
import type { useLibraryMenus } from "@/components/library/useLibraryMenus";
import type { useLibrarySelection } from "@/components/library/useLibrarySelection";
import type { useQueueMatch } from "@/components/library/useQueueMatch";
import type { usePlayingMatch } from "@/components/library/usePlayingMatch";

/** One container as the listing draws it: a card, or a row in the rows layout. */
export type ContainerItem = (node: MediaNode, item?: ListItemAttrs) => React.JSX.Element;

/** What a track row's caller says that only it knows: the art, an album row's note and
 *  performer line, and whether the links are on (the listing's only in search mode, a
 *  cross-server row's always). */
export interface TrackRowOpts {
  showArt: boolean;
  note?: string | null;
  artistLabel?: string | null;
  links: boolean;
  /** The list Info steps through when it isn't `siblings` (an album's every disc). */
  infoList?: MediaNode[];
  /** In a keyed list: the row's id and index. */
  item?: ListItemAttrs;
}
export type TrackRowOf = (
  node: MediaNode,
  siblings: MediaNode[],
  ti: number,
  opts: TrackRowOpts,
) => React.JSX.Element;

type OpenMenu = ReturnType<typeof useLibraryMenus>["openMenu"];

/** How the level lays its containers out: cards (the Presets size, gap and fill) or rows. */
interface GridLayout {
  cards: boolean;
  presetFillRows: boolean;
  presetCardSize: number;
  presetGap: number;
}

// FROM THE KEYBOARD (0.14.0, his K1 to K6): each grid or column of rows one Tab stop, Enter
// opens a folder or an album as its click does, "." its More menu
export function ContainerGrid({
  list,
  label = "Folders",
  cards,
  presetFillRows,
  presetCardSize,
  presetGap,
  enter,
  openMenu,
  folderMenus,
  containerItem,
}: GridLayout & {
  list: MediaNode[];
  label?: string;
  enter(node: MediaNode): void;
  openMenu: OpenMenu;
  /** A plain folder takes a More menu (a server's folders, browsed). */
  folderMenus: boolean;
  containerItem: ContainerItem;
}): React.JSX.Element {
  return (
    <KeyedList
      label={label}
      grid={cards}
      count={list.length}
      onEnter={(i) => {
        const n = list[i];
        if (n) enter(n);
      }}
      onMenu={(i, el) => {
        const n = list[i];
        if (n && (isAlbumClass(n.upnpClass) || isArtistClass(n.upnpClass) || folderMenus))
          openMenu(n, keyedEvent(el));
      }}
      className={cx(!cards && "divide-y divide-edge/50 -mx-2")}
      style={
        cards
          ? {
              display: "grid",
              gridTemplateColumns: presetFillRows
                ? `repeat(auto-fill, minmax(${presetCardSize}px, 1fr))`
                : `repeat(auto-fill, ${presetCardSize}px)`,
              gap: presetGap,
              paddingTop: 8,
            }
          : undefined
      }
    >
      {(item) => list.map((node, i) => containerItem(node, item(i)))}
    </KeyedList>
  );
}

// AN ARTIST PAGE NAMES WHAT IT HOLDS (2026-10-11, user: "do we want to add an 'Albums' title
// above the albums? i'm a little unclear exactly what this is supposed to be showing"): the
// server's own folder for the artist holds what that server decides (Asset: the albums;
// MinimServer: its sub-indexes, "2 albums", "Date", "Genre"), so the contents are labelled by
// kind as search results are, never one fixed title that is wrong on some server
export function LibraryFolders({
  containers,
  artistFolder,
  ...grid
}: GridLayout & {
  containers: MediaNode[];
  /** The level is an artist's folder: its albums and its other folders, labelled. */
  artistFolder: boolean;
  enter(node: MediaNode): void;
  openMenu: OpenMenu;
  folderMenus: boolean;
  containerItem: ContainerItem;
}): React.JSX.Element {
  if (!artistFolder) return <ContainerGrid list={containers} {...grid} />;
  const albums = containers.filter((c) => isAlbumClass(c.upnpClass));
  const other = containers.filter((c) => !isAlbumClass(c.upnpClass));
  return (
    <>
      {albums.length > 0 && (
        <>
          <div className="microlabel pb-0.5 px-1 pt-2">Albums</div>
          <ContainerGrid list={albums} label="Albums" {...grid} />
        </>
      )}
      {other.length > 0 && (
        <>
          <div className={cx("microlabel pb-0.5 px-1", albums.length > 0 ? "pt-5" : "pt-2")}>
            Folders
          </div>
          <ContainerGrid list={other} {...grid} />
        </>
      )}
    </>
  );
}

/** A level's tracks, always rows (the app-wide idiom: the Queue, Recently added, Favorites, an
 *  album's tracklist); an artist's folder labels them, as it labels its albums and folders. */
export function LibraryTracks({
  tracks,
  containers,
  artistNode,
  albumNode,
  albumArtist,
  searchMode,
  queueSourceActive,
  isCurrentTrack,
  trackRowClick,
  playTrack,
  openMenu,
  albumNoteFor,
  trackRow,
}: {
  tracks: MediaNode[];
  containers: MediaNode[];
  artistNode: MediaNode | null;
  albumNode: MediaNode | null;
  albumArtist: string | null;
  searchMode: boolean;
  queueSourceActive: boolean;
  isCurrentTrack: ReturnType<typeof usePlayingMatch>["isCurrentTrack"];
  trackRowClick: ReturnType<typeof useLibrarySelection>["trackRowClick"];
  playTrack: ReturnType<typeof useQueueMatch>["playTrack"];
  openMenu: OpenMenu;
  albumNoteFor(node: MediaNode): string | null;
  trackRow: TrackRowOf;
}): React.JSX.Element {
  return (
    <>
      {artistNode && (
        <div className={cx("microlabel pb-0.5 px-1", containers.length > 0 ? "pt-5" : "pt-2")}>
          Tracks
        </div>
      )}
      <KeyedList
        label="Tracks"
        count={tracks.length}
        // an album opened from the keyboard starts on the playing track
        initial={() => tracks.findIndex((t) => queueSourceActive && isCurrentTrack(t))}
        onEnter={(i, el) => {
          const t = tracks[i];
          if (t && !trackRowClick(t, keyedEvent(el))) playTrack(t, el);
        }}
        onMenu={(i, el) => {
          const t = tracks[i];
          if (t) openMenu(t, keyedEvent(el), tracks);
        }}
        className={cx(
          "divide-y divide-edge/50 -mx-2",
          containers.length > 0 && !searchMode && !artistNode && "mt-4",
        )}
      >
        {(item) => (
          <>
            {/* an album leaf that spans discs gets the same quiet "Disc N"
            dividers as the lens (one group, no divider, otherwise) */}
            {(albumNode ? discGroups(tracks) : [{ disc: null, tracks }]).map((g, gi) => (
              <div key={g.disc ?? `d${gi}`}>
                {g.disc != null && (
                  <div className="microlabel px-2 pt-3 pb-1" data-disc-divider>
                    Disc {g.disc}
                  </div>
                )}
                <div className="divide-y divide-edge/50">
                  {g.tracks.map((node, ti) =>
                    trackRow(node, g.tracks, ti, {
                      item: item(tracks.indexOf(node)),
                      // Info steps through the whole album, every disc
                      infoList: tracks,
                      showArt: !albumNode,
                      note: albumNoteFor(node),
                      artistLabel: albumNode
                        ? performerLine(node, albumArtist ?? albumNode.artist)
                        : null,
                      links: searchMode,
                    }),
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </KeyedList>
    </>
  );
}
