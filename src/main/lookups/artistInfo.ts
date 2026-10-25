// Artist context: MusicBrainz search -> URL relations -> Wikipedia summary
// (shared plumbing in mb.ts, including the 1 rps MusicBrainz gate). Results
// cache per artist name in a bounded disk-persisted LRU (diskCache.ts),
// including DEFINITIVE misses ("MB answered: no such artist" / "no Wikipedia
// linked"); transient failures anywhere in the chain (unreachable, timeout,
// 5xx) return the best partial answer for the moment but are never cached, so
// the next request retries. `force` bypasses the cache read for a
// user-driven refresh.
import type { ArtistInfo } from "@shared/model";
import { DiskCache } from "./diskCache";
import { MB, WIKI, getJson, mbFetch, wikipediaFromRels, type Fetched, type MbRelation } from "./mb";

// a library's worth of artists keeps its photos: every artist in the libraries is looked up
// ahead since 0.13.0 (artistPrefetch), so the cap is a large library's artists rather than a
// user's 518 (0.11.0); an entry is small, a summary paragraph and three addresses
const CACHE_MAX = 10_000;
const MIN_MATCH_SCORE = 75;

const cache = new DiskCache<ArtistInfo>("artist", CACHE_MAX);

interface MbArtist {
  id: string;
  name: string;
  score?: number;
}

/**
 * An artist looked up because someone asked (the panel's tab, an opened row, an agent) takes the
 * gate's urgent lane; the photos fetched ahead of time (artistPrefetch, 0.13.0) take the
 * speculative one, behind anything a person is waiting on.
 */
export async function fetchArtistInfo(
  artist: string,
  force = false,
  lane: "urgent" | "speculative" = "urgent",
): Promise<ArtistInfo | null> {
  const ask = (url: string): Promise<Fetched> => mbFetch(url, lane === "urgent");
  const key = artist.trim().toLowerCase();
  if (!key) return null;
  // Refresh details asks the article's images again too, the next time the chooser opens
  if (force) mediaStale.add(key);
  // an answer cached before photos were read (0.11.0) is asked again, once; if that ask cannot
  // finish, the answer already held (its summary and links) is what the page shows, never none
  // (the 0.11.0-rc.1 shots: The Cure's page came up bare beside a cached summary)
  let stale: ArtistInfo | null = null;
  if (!force && cache.has(key)) {
    const hit = cache.get(key);
    if (hit == null || hit.image !== undefined) return hit ?? null;
    stale = hit;
  }

  let result: ArtistInfo | null = null;
  // Only a conclusion built purely from real answers goes into the cache.
  let definitive = true;

  const searchGot = await ask(
    `${MB}/ws/2/artist?query=artist:${encodeURIComponent(JSON.stringify(artist))}&fmt=json&limit=3`,
  );
  if (searchGot.kind !== "ok") {
    // couldn't even search: nothing new to show or remember (what was held, if anything)
    return stale;
  }
  const match = (searchGot.body as { artists?: MbArtist[] }).artists?.[0];

  if (match && (match.score ?? 0) >= MIN_MATCH_SCORE) {
    const musicbrainzUrl = `https://musicbrainz.org/artist/${match.id}`;
    result = { name: match.name, summary: null, wikipediaUrl: null, musicbrainzUrl, image: null };

    const lookupGot = await ask(`${MB}/ws/2/artist/${match.id}?inc=url-rels&fmt=json`);
    if (lookupGot.kind !== "ok") {
      definitive = false; // summary state unknown — show the partial, retry later
    } else {
      const rels = (lookupGot.body as { relations?: MbRelation[] }).relations ?? [];
      const wiki = await wikipediaFromRels(rels);
      result.summary = wiki.summary;
      result.wikipediaUrl = wiki.wikipediaUrl;
      result.image = wiki.image;
      if (!wiki.definitive) definitive = false;
    }
  }
  // no match / low score with an OK search: an answer, cache the null (a held answer keeps its
  // words, marked as asked so it is not asked again)
  const answer = result ?? (stale ? { ...stale, image: null } : null);
  if (definitive) cache.set(key, answer);
  // an ask that could not finish without a summary keeps the held answer
  if (!definitive && stale && !result?.summary) return stale;
  return answer;
}

/** An artist's photo as already known, without asking anyone: the rows and cards read this
 *  (a lookup per row would be minutes of MusicBrainz at its one request a second). */
export function knownArtistImage(artist: string): string | null {
  const key = artist.trim().toLowerCase();
  if (!key || !cache.has(key)) return null;
  return cache.get(key)?.image ?? null;
}

/** Whether another artist fits without the cache dropping one: the photos fetched ahead stop at
 *  nine in ten of the cap, so a library larger than it never churns its own photos. */
export function artistCacheHasRoom(): boolean {
  return cache.stats().entries < CACHE_MAX * 0.9;
}

/** Whether the artist has been asked about and answered (a photo or a settled none). */
export function knowsArtist(artist: string): boolean {
  return cache.has(artist.trim().toLowerCase());
}

// THE ARTICLE'S OTHER IMAGES (0.13.0 round 7, the picture chooser): the images in the artist's
// Wikipedia article (its media list, no key needed: decisions/0001), as Wikimedia thumbnails, the
// lead picture first. Cached per article, settled answers only, like the summary.
const mediaCache = new DiskCache<string[]>("artistMedia", 1000);
/** Artists whose details were refreshed: their article's images are asked again, once. */
const mediaStale = new Set<string>();
/** At most this many images offered (an article with a gallery can hold dozens). */
const MEDIA_MAX = 24;

interface MediaItem {
  type?: string;
  title?: string;
  showInGallery?: boolean;
  srcset?: Array<{ src?: string; scale?: string }>;
}

/** A URL's part as text; a malformed escape stays as it was rather than throwing. */
function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The images an artist's article offers, the lead picture first; empty with no article. */
export async function fetchArtistImages(artist: string): Promise<string[]> {
  const info = await fetchArtistInfo(artist);
  const title = info?.wikipediaUrl
    ? decoded((info.wikipediaUrl.split("/wiki/")[1] ?? "").split(/[?#]/)[0])
    : "";
  const lead = info?.image ?? null;
  if (!title) return lead ? [lead] : [];
  const stale = mediaStale.delete(artist.trim().toLowerCase());
  let images = !stale && mediaCache.has(title) ? (mediaCache.get(title) ?? []) : null;
  if (images == null) {
    const got = await getJson(
      "wikipedia",
      `${WIKI}/api/rest_v1/page/media-list/${encodeURIComponent(title)}`,
    );
    if (got.kind === "error") return lead ? [lead] : [];
    const items = got.kind === "ok" ? ((got.body as { items?: MediaItem[] }).items ?? []) : [];
    images = items
      .filter(
        (it) =>
          it.type === "image" && it.showInGallery !== false && !/\.svg$/i.test(it.title ?? ""),
      )
      .map((it) => it.srcset?.find((s) => s.scale === "1x")?.src ?? it.srcset?.[0]?.src ?? "")
      .filter(Boolean)
      .map((src) => (src.startsWith("//") ? `https:${src}` : src))
      .filter((src) => /^https?:\/\//.test(src))
      .slice(0, MEDIA_MAX);
    mediaCache.set(title, images);
  }
  // the lead first, and once: the media list names the same file at another size (and another
  // query: Wikipedia tags its links by where they were handed out)
  const file = (u: string): string =>
    decoded(u.split(/[?#]/)[0].split("/").pop() ?? "").replace(/^\d+px-/, "");
  return lead ? [lead, ...images.filter((u) => file(u) !== file(lead))] : images;
}
