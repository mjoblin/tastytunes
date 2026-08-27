// Cover Art Archive fallback: front cover for an album the media server
// offers no art for. Rides the SAME identifier the album-context panel
// already resolves (the MusicBrainz release-group), so the missing-art case
// is fillable with no new account, key, or privacy story beyond adding
// coverartarchive.org beside musicbrainz.org in the table. Server art always
// wins — this is only consulted when there is none. Cached as a data URL in
// the bounded disk LRU, INCLUDING definitive misses (a release group with no
// cover, or no MB match at all), so an artless album is not re-asked on
// every render. Gated by settings.artistInfo at the IPC layer, like the
// context lookups themselves.
import { fetchAlbumInfo } from "./albumInfo";
import { DiskCache } from "./diskCache";
import { loggedFetch } from "../netlog";

const CAA = process.env["TASTYTUNES_CAA_URL"] ?? "https://coverartarchive.org";
/** Bounded low: entries are whole images as data URLs (~100 KB each). */
const CACHE_MAX = 120;
const cache = new DiskCache<string | null>("coverart", CACHE_MAX);

export async function fetchCoverArt(artist: string, album: string): Promise<string | null> {
  const key = `${artist.toLowerCase()}|${album.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const info = await fetchAlbumInfo(artist, album, false);
  const mbid = info?.musicbrainzUrl?.split("/").at(-1) ?? null;
  if (mbid == null) {
    // fetchAlbumInfo caches its own definitive misses; mirror its verdict.
    cache.set(key, null);
    return null;
  }
  try {
    const res = await loggedFetch("caa", `${CAA}/release-group/${mbid}/front-500`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      cache.set(key, null); // definitive: MB knows the album, the archive has no cover
      return null;
    }
    if (!res.ok) return null; // transient — retry next time, never cached
    const type = res.headers.get("content-type") ?? "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    const url = `data:${type};base64,${buf.toString("base64")}`;
    cache.set(key, url);
    return url;
  } catch {
    return null; // network trouble is never a verdict
  }
}
