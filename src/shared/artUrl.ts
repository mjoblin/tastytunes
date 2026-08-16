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
const ASSET_ART = /^(https?:\/\/[^/]+\/aa\/\d+\/cover\.jpg)(?:\?size=\d+)?$/i

/**
 * The URL to fetch for art drawn `px` CSS pixels wide/tall. Ask for 2× the
 * CSS size (Retina), never less than 64. Unknown servers: the URL unchanged.
 */
export function artUrlAt(url: string | null | undefined, px: number): string | null {
  if (!url) return null
  const m = ASSET_ART.exec(url)
  if (!m) return url
  const want = Math.max(64, Math.round(px * 2))
  return `${m[1]}?size=${want}`
}

/** True when this URL is one artUrlAt() knows how to resize (for tests and callers that care). */
export function artUrlResizable(url: string | null | undefined): boolean {
  return !!url && ASSET_ART.test(url)
}
