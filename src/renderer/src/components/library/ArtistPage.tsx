import { useMemo } from "react";
import {
  albumOfTrack,
  type AppSettings,
  type MediaIndexPools,
  type MediaNode,
} from "@shared/model";
import { ArtistHeader } from "@/components/library/ArtistHeader";
import { ContainerCard, ContainerRow, TrackRow } from "@/components/library/LibraryCards";
import { useLensIndex } from "@/components/library/lenses/useLensIndex";
import { useCardDetails } from "@/components/library/useCardDetails";
import {
  COPY_BADGE_TIP,
  nodeKey,
  orderArtistAlbums,
  type LensActions,
} from "@/components/library/lenses/lensShared";
import { SortChip } from "@/components/controls/SortChip";
import { GAP_WITHIN } from "@/components/chrome/Chrome";
import { ViewOptions } from "@/components/library/lenses/ViewOptions";
import { useStore } from "@/store";
import {
  LensTrackMenu,
  useLensTrackSelection,
} from "@/components/library/lenses/useLensTrackSelection";
import { cx } from "@/lib/format";
import { KeyedList } from "@/components/controls/KeyedList";
import { keyedEvent } from "@/lib/menuAt";
import type { LandingTrack } from "@/components/library/landing";
import { nameKey } from "@shared/keys";

/** The page's album orders (0.13.0-rc.4): by year, newest first (the page's order since 0.11.0),
 *  or by title; the chip's arrow turns either. */
const ALBUM_SORTS: Array<{ value: AppSettings["artistPageSort"]; label: string }> = [
  { value: "year", label: "Year (newest first)" },
  { value: "title", label: "Title" },
];

/**
 * THE ARTIST PAGE (the Albums lens reaches an album page, so the Artists lens reaches an artist
 * page, the app's own). One page per artist, the same on every server: built from the indexes
 * as the Artists lens is (its artist, its albums newest first, its credited tracks), never from
 * a server's folder, whose contents each server decides. It sits over the Artists lens (the
 * lens's columns are untouched): the header (ArtistHeader), the artist's albums as the
 * Library's cards or rows, then APPEARS ON, their tracks on other artists' albums, and TRACKS,
 * their loose ones, as the lens's track rows with its selection. No link to the server's own
 * folder for the artist (to the reader it would be effectively the same page): on Asset it
 * holds the same albums, on MinimServer its sub-indexes group them again, and browsing the
 * server still reaches it.
 */
export function ArtistPage({
  name,
  pools,
  actions,
  cards,
  cardSize,
  cardGap,
  fillRows,
  onOpenAlbum,
}: {
  name: string;
  pools: MediaIndexPools[];
  actions: LensActions;
  cards: boolean;
  cardSize: number;
  cardGap: number;
  fillRows: boolean;
  /** An album, and from an Appears-on row the track to land on. */
  onOpenAlbum(node: MediaNode, track?: LandingTrack): void;
}): React.JSX.Element {
  const index = useLensIndex(pools);
  // each card's format line, while View options shows it (useCardDetails)
  const detailsOf = useCardDetails(index);
  const key = nameKey(name);
  const artist = index.artists.find((a) => a.key === key) ?? null;
  const sort = useStore((s) => s.settings.artistPageSort);
  const reversed = useStore((s) => s.settings.artistPageSortReversed);
  const saveSettings = useStore((s) => s.saveSettings);
  // in the order the page's sort asks (by year, newest first, unless changed: the lens index's)
  const albums = useMemo(
    () => orderArtistAlbums(artist?.albums ?? [], sort, reversed),
    [artist, sort, reversed],
  );
  // their tracks beyond their own albums: APPEARS ON, a credit on another artist's album (by
  // title, on its server), then TRACKS, the loose ones that belong to no album. One list, one
  // selection, two labelled runs
  const { others, appearsCount } = useMemo(() => {
    if (!artist) return { others: [], appearsCount: 0 };
    const own = new Set(artist.albums.map((a) => `${a.serverUdn ?? ""}|${nameKey(a.title)}`));
    const rest = artist.tracks.filter((t) => !own.has(`${t.serverUdn ?? ""}|${nameKey(t.album)}`));
    const appears = rest.filter((t) => t.album);
    return { others: [...appears, ...rest.filter((t) => !t.album)], appearsCount: appears.length };
  }, [artist]);
  const sel = useLensTrackSelection({ tracks: others, actions });
  // an Appears-on row names the album it is on, linked as the Tracks lens links it: the album by
  // content identity in the track's own pool
  const albumOf = (t: MediaNode): MediaNode | null => {
    const pool = pools.find((p) => p.udn === t.serverUdn);
    return pool ? albumOfTrack(t, pool) : null;
  };
  const label = (text: string, first: boolean): React.JSX.Element => (
    <div className={cx("microlabel pb-0.5 px-1", first ? "pt-2" : "pt-6")}>{text}</div>
  );
  return (
    <div data-artist-page={name}>
      <ArtistHeader name={artist?.name ?? name} serverArt={artist?.ownArt} folders={albums} />
      {albums.length > 0 && (
        <>
          {/* the albums' heading, and their order at its right (0.13.0-rc.4: the order was
              there, unseen, behind each card's cut-off year) */}
          <div className="flex items-end justify-between gap-3 px-1 pt-2" data-artist-albums-head>
            <div className="microlabel pb-0.5">Albums</div>
            <div className={`flex items-center ${GAP_WITHIN}`}>
              <ViewOptions kind="albums" />
              <SortChip
                sorts={ALBUM_SORTS}
                neutral="year"
                value={sort}
                reversed={reversed}
                onChange={(v) =>
                  void saveSettings({ artistPageSort: v, artistPageSortReversed: false })
                }
                onToggleReverse={() => void saveSettings({ artistPageSortReversed: !reversed })}
              />
            </div>
          </div>
          {/* FROM THE KEYBOARD (0.14.0): the albums one Tab stop, each run of tracks
              another; Enter opens an album or plays a track, as their clicks do */}
          <KeyedList
            label="Albums"
            grid={cards}
            count={albums.length}
            onEnter={(i) => {
              const n = albums[i];
              if (n) onOpenAlbum(n);
            }}
            onMenu={(i, el) => {
              const n = albums[i];
              if (n) actions.openMenu(n, keyedEvent(el));
            }}
            className={cx(!cards && "divide-y divide-edge/50 -mx-3")}
            style={
              cards
                ? {
                    display: "grid",
                    gridTemplateColumns: fillRows
                      ? `repeat(auto-fill, minmax(${cardSize}px, 1fr))`
                      : `repeat(auto-fill, ${cardSize}px)`,
                    gap: cardGap,
                    paddingTop: 8,
                  }
                : undefined
            }
          >
            {(item) =>
              albums.map((node, ai) => {
                const common = {
                  node,
                  item: item(ai),
                  playing: actions.isPlayingAlbum(node),
                  menuOpen: actions.menuNodeId === node.id,
                  favorited: actions.nodeFavorited(node),
                  onHeart: () => actions.heartNode(node),
                  onEnter: () => onOpenAlbum(node),
                  onMenu: (e: React.MouseEvent) => actions.openMenu(node, e),
                  onNavDrag: (e: React.PointerEvent) => actions.dragAlbum([node], e, node.title),
                  // which copy, only when there is another (the same albums on a media server and
                  // on the streamer's drive; a user's two editions of one album on one server),
                  // the Albums lens's rule; an album with no other copy shows none, its year not
                  // squeezed by a chip that says nothing
                  badge: index.copyBadge(node, { formatShown: cards && detailsOf != null }),
                  badgeTip: COPY_BADGE_TIP,
                };
                return cards ? (
                  <ContainerCard
                    key={nodeKey(node)}
                    {...common}
                    // the page is the artist's: a card says its year, the order's key, whole
                    subtitle={node.year ?? ""}
                    details={detailsOf?.(node)}
                    onPlay={(el) => void actions.playContainer(node, el)}
                  />
                ) : (
                  <ContainerRow key={nodeKey(node)} {...common} />
                );
              })
            }
          </KeyedList>
        </>
      )}
      {others.length > 0 && (
        <div data-artist-others>
          {[
            { label: "Appears on", from: 0, to: appearsCount },
            { label: "Tracks", from: appearsCount, to: others.length },
          ]
            .filter((run) => run.to > run.from)
            .map((run) => (
              <div key={run.label} data-artist-run={run.label}>
                {label(run.label, albums.length === 0 && run.from === 0)}
                <KeyedList
                  label={run.label}
                  count={run.to - run.from}
                  onEnter={(i, el) => {
                    const t = others[run.from + i];
                    if (t && !sel.trackRowClick(t, keyedEvent(el))) actions.playTrack(t, el);
                  }}
                  onMenu={(i, el) => {
                    const t = others[run.from + i];
                    if (t) sel.rowMenu(t, keyedEvent(el));
                  }}
                  className="divide-y divide-edge/50 -mx-3"
                >
                  {(item) =>
                    others.slice(run.from, run.to).map((t, i) => {
                      const ti = run.from + i;
                      const album = t.album ? albumOf(t) : null;
                      return (
                        <TrackRow
                          key={nodeKey(t)}
                          item={item(i)}
                          node={t}
                          showArt
                          isCurrent={actions.isCurrentTrack(t)}
                          queued={actions.trackQueued(t)}
                          menuOpen={actions.menuNodeId === t.id}
                          favorited={actions.nodeFavorited(t)}
                          selected={sel.selT.has(nodeKey(t))}
                          selStart={!(ti > run.from && sel.selT.has(nodeKey(others[ti - 1])))}
                          selEnd={!(ti < run.to - 1 && sel.selT.has(nodeKey(others[ti + 1])))}
                          onRowClick={(e) => sel.trackRowClick(t, e)}
                          onNavDrag={(e) => sel.startTrackDrag(t, e)}
                          onHeart={() => actions.heartNode(t)}
                          onPlayNow={(el) => actions.playTrack(t, el)}
                          onMenu={(e) => sel.rowMenu(t, e)}
                          onAlbumLink={
                            album
                              ? () =>
                                  onOpenAlbum(album, {
                                    title: t.title,
                                    id: t.id,
                                    secs: t.durationSecs,
                                  })
                              : undefined
                          }
                        />
                      );
                    })
                  }
                </KeyedList>
              </div>
            ))}
        </div>
      )}
      {!artist && (
        <div className="text-[13px] text-faint pt-2 px-1">
          No albums or tracks by {name} in your indexed libraries.
        </div>
      )}
      {sel.dragGhost}
      <LensTrackMenu sel={sel} />
    </div>
  );
}
