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
import { MB, mbFetch, wikipediaFromRels, type Fetched, type MbRelation } from "./mb";

/** An artist is only ever looked up because someone asked — the panel's tab,
 *  an opened row, an agent — so it takes the gate's urgent lane. */
const ask = (url: string): Promise<Fetched> => mbFetch(url, true);

// a library's worth of artists keeps its photos (a user's 518 artists); entries are small
const CACHE_MAX = 1000;
const MIN_MATCH_SCORE = 75;

const cache = new DiskCache<ArtistInfo>("artist", CACHE_MAX);

interface MbArtist {
  id: string;
  name: string;
  score?: number;
}

export async function fetchArtistInfo(artist: string, force = false): Promise<ArtistInfo | null> {
  const key = artist.trim().toLowerCase();
  if (!key) return null;
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
