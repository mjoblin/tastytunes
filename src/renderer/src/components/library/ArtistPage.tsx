import { useMemo } from "react";
import { albumOfTrack, type MediaIndexPools, type MediaNode } from "@shared/model";
import { ArtistHeader } from "@/components/library/ArtistHeader";
import { ContainerCard, ContainerRow, TrackRow } from "@/components/library/LibraryCards";
import { useLensIndex } from "@/components/library/lenses/useLensIndex";
import { lc, nodeKey, type LensActions } from "@/components/library/lenses/lensShared";
import {
  LensTrackMenu,
  useLensTrackSelection,
} from "@/components/library/lenses/useLensTrackSelection";
import { cx } from "@/lib/format";
import type { LandingTrack } from "@/components/library/landing";

/**
 * THE ARTIST PAGE (2026-10-11, the user: "we get to an album page from the albums lens. but we
 * can't get to an artist page from the artist lens ... it'd be nice to make that more sensical
 * for the user"; option 2, the app's own page). One page per artist, the same on every server:
 * built from the indexes as the Artists lens is (its artist, its albums newest first, its
 * credited tracks), never from a server's folder, whose contents each server decides. It sits
 * over the Artists lens (the lens's columns are untouched: "i really like that"): the header
 * (ArtistHeader), the artist's albums as the Library's cards or rows, then APPEARS ON, their
 * tracks on other artists' albums, and TRACKS, their loose ones, as the lens's track rows with
 * its selection. No link to the server's own folder for the artist (the user: "it links to
 * what is (to the user) effectively the same page"): on Asset it holds the same albums, on
 * MinimServer its sub-indexes group them again, and browsing the server still reaches it.
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
  const key = lc(name);
  const artist = index.artists.find((a) => a.key === key) ?? null;
  const albums = artist?.albums ?? [];
  // their tracks beyond their own albums: APPEARS ON, a credit on another artist's album (by
  // title, on its server), then TRACKS, the loose ones that belong to no album. One list, one
  // selection, two labelled runs
  const { others, appearsCount } = useMemo(() => {
    if (!artist) return { others: [], appearsCount: 0 };
    const own = new Set(artist.albums.map((a) => `${a.serverUdn ?? ""}|${lc(a.title)}`));
    const rest = artist.tracks.filter((t) => !own.has(`${t.serverUdn ?? ""}|${lc(t.album)}`));
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
          {label("Albums", true)}
          <div
            className={cx(!cards && "divide-y divide-edge/50 -mx-2")}
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
            {albums.map((node) => {
              const common = {
                node,
                playing: actions.isPlayingAlbum(node),
                menuOpen: actions.menuNodeId === node.id,
                favorited: actions.nodeFavorited(node),
                onHeart: () => actions.heartNode(node),
                onEnter: () => onOpenAlbum(node),
                onMenu: (e: React.MouseEvent) => actions.openMenu(node, e),
                onNavDrag: (e: React.PointerEvent) => actions.dragAlbum([node], e, node.title),
                // which library, only when the same album is in another one too (his Jack White:
                // the same albums on minitunes and on the streamer's drive), the Albums lens's
                // rule; an album in one library shows none, its year not squeezed by a chip that
                // says nothing
                badge: index.inTwoLibraries(node) ? (node.serverName ?? undefined) : undefined,
              };
              return cards ? (
                <ContainerCard
                  key={nodeKey(node)}
                  {...common}
                  onPlay={(el) => void actions.playContainer(node, el)}
                />
              ) : (
                <ContainerRow key={nodeKey(node)} {...common} />
              );
            })}
          </div>
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
                <div className="divide-y divide-edge/50 -mx-2">
                  {others.slice(run.from, run.to).map((t, i) => {
                    const ti = run.from + i;
                    const album = t.album ? albumOf(t) : null;
                    return (
                      <TrackRow
                        key={nodeKey(t)}
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
                  })}
                </div>
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
