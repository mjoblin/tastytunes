import { type MediaIndexPools, type MediaNode, type MediaServerInfo } from "@shared/model";
import {
  copiesOf,
  copyMarkOf,
  favoriteKey,
  heartFacts,
  heartOf,
  heartPeersFrom,
  nodeFacts,
  type Favorite,
  type FavoriteMedia,
  type HeartItem,
} from "@shared/model";
import { queueWrite, tt } from "@/api";
import { useStore } from "@/store";
import { cachedPools } from "@/hooks/useIndexPools";
import { isAlbumClass } from "@/lib/media";

// Renderer-side favorites helpers: whether a copy is hearted, toggling, and
// playing media favorites by content identity (stored objectId fast path →
// scoped search fallback).

/** The other copies a heart is told apart from: the last pools snapshot this window read, by
 *  content (made once per snapshot). */
let peers: { pools: MediaIndexPools[]; of: ReturnType<typeof heartPeersFrom> } | null = null;
function heartPeers(item: HeartItem): readonly MediaNode[] {
  const pools = cachedPools();
  if (!pools) return [];
  if (peers?.pools !== pools) peers = { pools, of: heartPeersFrom(pools) };
  return peers.of(item);
}

/** The favorite this copy carries, if any (0.13.0: each copy its own heart; shared/model
 *  heartOf against the library's other copies). */
export function heartOfItem(
  item: HeartItem,
  favorites: readonly Favorite[] = useStore.getState().favorites,
): FavoriteMedia | null {
  return heartOf(item, favorites, heartPeers(item));
}

/** Is this hearted: a station by its URL, a track or an album by its copy. Every surface's heart
 *  asks this, never a key compared with a key. */
export function isFavorited(fav: NewFavorite, favorites: readonly Favorite[]): boolean {
  return fav.kind === "station"
    ? favorites.some((f) => favoriteKey(f) === favoriteKey({ ...fav, addedAt: 0 }))
    : heartOfItem(fav, favorites) != null;
}

/** Omit that distributes over the Favorite union (plain Omit collapses it). */
export type NewFavorite = {
  [K in Favorite as K["kind"]]: Omit<K, "addedAt">;
}[Favorite["kind"]];

/**
 * Add-or-remove; resolves to the new "is favorited" state. A station by its URL; a track or an
 * album by its COPY (0.13.0): the heart this copy carries is removed, else a new one is made with
 * the copy's mark, beside any other copy's.
 *
 * Every UI toggle lands on the undo stack (the inverse is the same toggle);
 * `silent` is for the calls that must NOT push — undo closures themselves,
 * and batch verbs that push one aggregate entry for the lot.
 */
export async function toggleFavorite(
  fav: NewFavorite,
  opts?: { silent?: boolean },
): Promise<boolean> {
  const addedAt = Date.now();
  const favorites = useStore.getState().favorites;
  const carried =
    fav.kind === "station"
      ? (favorites.find((f) => favoriteKey(f) === favoriteKey({ ...fav, addedAt })) ?? null)
      : heartOfItem(fav, favorites);
  const exists = carried != null;
  const full: Favorite =
    fav.kind === "station"
      ? { ...fav, addedAt }
      : { ...fav, addedAt, copy: copyMarkOf(fav, addedAt) };
  if (!opts?.silent) {
    const name = ("title" in fav ? fav.title : null) ?? ("name" in fav ? fav.name : null);
    useStore
      .getState()
      .pushUndo(
        exists
          ? `Remove ${name ? `“${name}”` : "Favorite"} from Favorites`
          : `Add ${name ? `“${name}”` : "Favorite"} to Favorites`,
        () => void toggleFavorite(fav, { silent: true }),
      );
  }
  if (carried) {
    await tt.favoriteRemove(favoriteKey(carried));
    return false;
  }
  await tt.favoriteAdd(full);
  return true;
}

const eq = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** Does a library node content-match a media favorite (the resolve target)? */
export function favoriteMatchesNode(fav: FavoriteMedia, n: MediaNode): boolean {
  if (!eq(fav.title, n.title)) return false;
  if (fav.artist != null && n.artist != null && !eq(fav.artist, n.artist)) return false;
  if (fav.kind === "album") return n.isContainer && isAlbumClass(n.upnpClass);
  if (fav.album != null && n.album != null && !eq(fav.album, n.album)) return false;
  return !n.isContainer;
}

/** Is there ANY route to this favorite right now (own server or a search)? */
export const favoriteHasRoute = (fav: FavoriteMedia, servers: MediaServerInfo[]): boolean =>
  servers.some((s) => s.udn === fav.serverUdn) || servers.some((s) => s.searchable);

export type FavoriteActResult = "ok" | "healed" | "missing" | "no-server" | "declined";

/**
 * Run a library action against a media favorite. The stored objectId on its
 * own server is tried first (ids rot — a throw is expected, not fatal); then
 * each searchable server is asked by content, the heart's own copy first
 * where a server holds two (0.13.0). A hit on the heart's own server HEALS
 * the stored hint so the next play takes the fast path; a hit on another
 * server plays that copy while the heart's is away, and leaves the heart on
 * its own copy.
 */
export async function favoriteAct(
  fav: FavoriteMedia,
  run: (serverUdn: string, objectId: string) => Promise<void>,
): Promise<FavoriteActResult> {
  let servers: MediaServerInfo[];
  try {
    servers = await tt.mediaServers();
  } catch {
    return "no-server";
  }
  const own = fav.serverUdn != null ? servers.find((s) => s.udn === fav.serverUdn) : undefined;
  const hint = fav.objectId;
  if (own && hint) {
    // the hint first: a failure is a stale id (or a standby-rotted USB) and
    // falls through to the search path; a decline is the user's answer
    const outcome = await queueWrite(() => run(own.udn, hint));
    if (outcome !== "failed") return outcome;
  }
  const candidates = [
    ...(own && own.searchable ? [own] : []),
    ...servers.filter((s) => s.searchable && s.udn !== own?.udn),
  ];
  for (const server of candidates) {
    try {
      const { items } = await tt.mediaSearch(server.udn, fav.title);
      const matches = items.filter((n) => favoriteMatchesNode(fav, n));
      if (matches.length === 0) continue;
      const found = copiesOf(heartFacts(fav), matches, nodeFacts)[0];
      const outcome = await queueWrite(() => run(server.udn, found.id));
      if (outcome === "declined") return "declined";
      if (outcome === "failed") continue;
      if (fav.serverUdn != null && fav.serverUdn !== server.udn) return "ok";
      void tt.favoriteUpdate(favoriteKey(fav), {
        serverUdn: server.udn,
        serverName: server.name,
        objectId: found.id,
        artUrl: fav.artUrl ?? found.artUrl,
        // backfill a missing duration too — hearts captured before the field
        // existed (or from surfaces without one) otherwise stay '–:––' forever
        durationSecs: fav.durationSecs ?? found.durationSecs,
        titlePath: null, // the old trail is meaningless on the healed server
      });
      return "healed";
    } catch {
      continue; // the search itself failed on this server
    }
  }
  return servers.length === 0 ? "no-server" : "missing";
}
