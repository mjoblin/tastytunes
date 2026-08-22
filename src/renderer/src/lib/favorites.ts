import { type MediaNode, type MediaServerInfo } from "@shared/model";
import { favoriteKey, type Favorite, type FavoriteMedia } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { isAlbumClass } from "@/lib/media";

// Renderer-side favorites helpers: toggling, and playing media favorites by
// content identity (stored objectId fast path → scoped search fallback).

export const useIsFavorite = (key: string | null): boolean =>
  useStore((s) => key != null && s.favorites.some((f) => favoriteKey(f) === key));

/** Omit that distributes over the Favorite union (plain Omit collapses it). */
export type NewFavorite = {
  [K in Favorite as K["kind"]]: Omit<K, "addedAt">;
}[Favorite["kind"]];

/** Add-or-remove by content key; resolves to the new "is favorited" state. */
export async function toggleFavorite(fav: NewFavorite): Promise<boolean> {
  const full = { ...fav, addedAt: Date.now() } as Favorite;
  const key = favoriteKey(full);
  const exists = useStore.getState().favorites.some((f) => favoriteKey(f) === key);
  if (exists) {
    await tt.favoriteRemove(key);
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

export type FavoriteActResult = "ok" | "healed" | "missing" | "no-server";

/**
 * Run a library action against a media favorite. The stored objectId on its
 * own server is tried first (ids rot — a throw is expected, not fatal); then
 * each searchable server is asked by content, and a hit HEALS the stored
 * hint so the next play takes the fast path.
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
  if (own && fav.objectId) {
    try {
      await run(own.udn, fav.objectId);
      return "ok";
    } catch {
      // stale id (or standby-rotted USB) — fall through to the search path
    }
  }
  const candidates = [
    ...(own && own.searchable ? [own] : []),
    ...servers.filter((s) => s.searchable && s.udn !== own?.udn),
  ];
  for (const server of candidates) {
    try {
      const { items } = await tt.mediaSearch(server.udn, fav.title);
      const found = items.find((n) => favoriteMatchesNode(fav, n));
      if (!found) continue;
      await run(server.udn, found.id);
      void tt.favoriteUpdate(favoriteKey(fav as Favorite), {
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
      continue;
    }
  }
  return servers.length === 0 ? "no-server" : "missing";
}
