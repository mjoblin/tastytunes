import type { MediaNode } from "./model";

/**
 * Artwork URLs at the size we draw them.
 *
 * Servers hand out ONE albumArtURI per node and most serve the full cover
 * from it. Asset serves the ORIGINAL — 1386×1400, ~220 KB, live-measured
 * 2026-08-15 — for a 40px row thumb, which on a 367-artist lens is tens of
 * megabytes of JPEG decode on first paint. Asset's URL is a resizing
 * endpoint (`/aa/<id>/cover.jpg?size=N` → N px on the long side; ?size=160
 * came back 158×160 at 4.4 KB), so a caller that knows how big it will draw
 * can ask for that. This is the ONE place that knowledge lives; every other
 * server's URL passes through untouched, and Asset's own full-size URL is
 * what gets stored — the index never bakes a size in.
 */

// Asset UPnP: http://host:port/aa/<numeric id>/cover.jpg[?size=N]
const ASSET_ART = /^(https?:\/\/[^/]+\/aa\/\d+\/cover\.jpg)(?:\?size=\d+)?$/i;

/**
 * The URL to fetch for art drawn `px` CSS pixels wide/tall. Ask for 2× the
 * CSS size (Retina), never less than 64. Unknown servers: the URL unchanged.
 */
export function artUrlAt(url: string | null | undefined, px: number): string | null {
  if (!url) return null;
  const m = ASSET_ART.exec(url);
  if (!m) return url;
  const want = Math.max(64, Math.round(px * 2));
  return `${m[1]}?size=${want}`;
}

/** True when this URL is one artUrlAt() knows how to resize (for tests and callers that care). */
export function artUrlResizable(url: string | null | undefined): boolean {
  return !!url && ASSET_ART.test(url);
}

// Wikimedia's thumbnails: .../wikipedia/<wiki>/thumb/<a>/<ab>/<file>/<width>px-<file>
const WIKI_THUMB =
  /^(https:\/\/upload\.wikimedia\.org\/wikipedia\/[^/]+\/thumb\/.+\/)(\d+)px-([^/]+)$/;
/** Wikimedia's standard thumbnail widths: a width off this list is made on demand and
 *  rate-limited, one on it is served from their cache. */
const WIKI_STEPS = [330, 500, 960, 1280];

/**
 * An artist's Wikipedia photo drawn `px` CSS pixels wide (0.11.0, the resizable header): the
 * article summary hands out a thumbnail about 320 px wide, sharp at the header's default 160
 * and soft when the picture is dragged larger, so the thumbnail is asked for again at the
 * smallest standard width covering 2× the size (Retina). Null when the URL is not a Wikimedia
 * thumbnail or is already wide enough; a width larger than the original fails, and the caller
 * keeps the picture it has.
 */
export function wikiThumbAt(url: string | null | undefined, px: number): string | null {
  const m = url ? WIKI_THUMB.exec(url) : null;
  if (!m) return null;
  const want = Math.round(px * 2);
  const has = Number(m[2]);
  if (has >= want) return null;
  const step = WIKI_STEPS.find((w) => w >= want) ?? WIKI_STEPS[WIKI_STEPS.length - 1];
  return step > has ? `${m[1]}${step}px-${m[3]}` : null;
}

/** A node's art identity: the server and the album it belongs to (its own title for an
 *  album). The thumbnail cache's key (main/lookups/artThumbs), shared since 2026-09-14 so
 *  the renderer's cards and the MCP bridge's get_album_art find the same file; the cache
 *  stores by thumbKey, which adds the picture's URL wherever the URL is the picture's own. */
export function artKeyOf(
  node: Pick<MediaNode, "serverUdn" | "title" | "album" | "artist" | "albumArtist" | "isContainer">,
): string {
  const album = node.isContainer ? node.title : (node.album ?? node.title);
  const artist = node.albumArtist ?? node.artist ?? "";
  return `${node.serverUdn ?? ""}|${album.trim().toLowerCase()}|${artist.trim().toLowerCase()}`;
}

/** Whether a picture comes from the streamer's own art server: its host is the connected
 *  streamer's, whatever the port (the Evo serves its pictures on another port than its control
 *  socket). */
export function isDeviceArt(origin: string, streamerHost: string | null): boolean {
  if (!streamerHost) return false;
  try {
    const own = new URL(`http://${streamerHost}`).hostname.replace(/^\[|\]$/g, "");
    return new URL(origin).hostname.replace(/^\[|\]$/g, "") === own;
  } catch {
    return false;
  }
}

/** What the thumbnail cache stores a picture under. On the streamer's own art server the
 *  content key alone, since its URLs change with every standby (the drive's mount counter is in
 *  its ids) and a rotated id must find the same file; everywhere else the content key and the
 *  URL, since there a URL is the picture's own, and the content key alone gave two editions of
 *  one album, or two ">> Disc 1" folders of one artist, the same picture (a user's MinimServer,
 *  2026-10-24). */
export function thumbKey(key: string, origin: string, device: boolean): string {
  return device ? key : `${key}|${origin}`;
}
