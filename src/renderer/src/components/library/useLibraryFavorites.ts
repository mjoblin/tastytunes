import { useMemo } from "react";
import { favoriteKey, type Favorite, type FavoriteMedia, type MediaNode } from "@shared/model";
import { useStore } from "@/store";
import { toggleFavorite } from "@/lib/favorites";

// The Library's FAVORITES, lifted out of LibraryScreen (2026-09-13, the fourth
// lift of the screen's hygiene round): a node as a favorite payload with its
// resolution hints, whether a node is a favorite, and the hearts, single and
// batched (one aggregate undo entry for the lot). The screen keeps the trail
// titles (its synthetic crumb ids are known there) and hands them in.

export function useLibraryFavorites(d: {
  serverUdn: string | null;
  serverName: string | null;
  searchMode: boolean;
  /** The current trail's titles, the synthetic crumbs stripped. */
  pathTitles: string[];
  albumNode: MediaNode | null;
  albumArtist: string | null;
  albumArt: string | null;
}) {
  const { serverUdn, serverName, searchMode, pathTitles, albumNode, albumArtist, albumArt } = d;
  const favorites = useStore((s) => s.favorites);
  const favKeys = useMemo(() => new Set(favorites.map(favoriteKey)), [favorites]);
  /**
   * A library node as a favorite payload. Content identity + resolution
   * hints: the entered album's titlePath is the current trail (it already
   * ends in the album); a listed node appends its own title. Search results
   * carry no trustworthy trail (their true folder is unknown) — null.
   */
  const mediaFav = (node: MediaNode): Omit<FavoriteMedia, "addedAt"> => ({
    kind: node.isContainer ? "album" : "track",
    title: node.title,
    artist: node === albumNode ? (albumArtist ?? node.artist) : node.artist,
    album: node.isContainer ? null : node.album,
    artUrl: node === albumNode ? (albumArt ?? node.artUrl) : node.artUrl,
    serverUdn: node.serverUdn ?? serverUdn,
    serverName: node.serverName ?? serverName,
    objectId: node.id,
    titlePath: searchMode
      ? null
      : node === albumNode
        ? pathTitles
        : node.isContainer
          ? [...pathTitles, node.title]
          : pathTitles,
    durationSecs: node.isContainer ? null : node.durationSecs,
  });
  const nodeFavorited = (node: MediaNode): boolean =>
    favKeys.has(favoriteKey(mediaFav(node) as Favorite));
  const heartNode = (node: MediaNode, opts?: { silent?: boolean }): void => {
    void toggleFavorite(mediaFav(node), opts);
  };
  /** The batch heart verbs: one aggregate undo entry for the lot (per-item
   *  pushes would flood the stack), silent per-item toggles. */
  const heartNodes = (nodes: MediaNode[], allIn: boolean): void => {
    const touched = nodes.filter((n) => (allIn ? nodeFavorited(n) : !nodeFavorited(n)));
    for (const n of touched) heartNode(n, { silent: true });
    if (touched.length === 0) return;
    const count = touched.length;
    useStore
      .getState()
      .pushUndo(
        allIn
          ? `Remove ${count} ${count === 1 ? "Track" : "Tracks"} from Favorites`
          : `Add ${count} ${count === 1 ? "Track" : "Tracks"} to Favorites`,
        () => {
          for (const n of touched) heartNode(n, { silent: true });
        },
      );
  };

  return { nodeFavorited, heartNode, heartNodes };
}
