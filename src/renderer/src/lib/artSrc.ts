import { artUrlAt, artUrlResizable } from "@shared/artUrl";

/** The cache key, shared with main (the MCP bridge's get_album_art) since 2026-09-14. */
export { artKeyOf } from "@shared/artUrl";

/**
 * The src to draw art from, at the size it is drawn (2026-09-14). A server that
 * resizes on request (Asset) is asked for the size, as artUrlAt always did.
 * Every other server's picture draws through the app's own thumbnail cache
 * (main/lookups/artThumbs, the tt-art: protocol): a 320 px thumb up to 160 px
 * CSS, a 480 px card up to 240; anything drawn larger, the Now Playing hero,
 * keeps the original. `key` is the picture's content identity when the caller
 * has the node (artKeyOf), so the streamer's rotating art ids find the same
 * thumbnail; without one the URL is the key.
 */
export function artSrc(url: string | null | undefined, px: number, key?: string): string | null {
  if (!url) return null;
  if (artUrlResizable(url)) return artUrlAt(url, px);
  if (/^(data|blob|tt-art):/.test(url)) return url;
  const want = px * 2;
  if (want > 480) return url;
  const tier = want <= 320 ? "thumb" : "card";
  return `tt-art://thumb/${tier}/${encodeURIComponent(key ?? url)}?u=${encodeURIComponent(url)}`;
}
