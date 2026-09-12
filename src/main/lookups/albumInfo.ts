// Album context: MusicBrainz release-group search -> release-group lookup
// (genre tags + Wikipedia via url-rels) -> earliest release lookup (label +
// release-level credits). Shares mb.ts's 1 rps MusicBrainz gate. Results
// cache per artist+album in a bounded disk-persisted LRU (diskCache.ts),
// including DEFINITIVE misses; transient failures return the best partial
// answer but are never cached, so the next request retries. `force` bypasses
// the cache read for the panel's refresh.
import type { AlbumInfo } from "@shared/model";
import { DiskCache } from "./diskCache";
import { MB, mbFetch, wikipediaFromRels, type Fetched, type MbRelation } from "./mb";

const CACHE_MAX = 500;
const MIN_MATCH_SCORE = 75;

/** The album as MusicBrainz names its release group: Apple's catalogue (and
 *  so AirPlay's metadata) suffixes singles and EPs — "White Keys - Single",
 *  "Don't Forget About Me, Demos - EP" — while MB titles the release group
 *  "White Keys" and types it. Searched with the suffix, nothing scored high
 *  enough and the miss was cached (found 2026-09-12 on the History screen's
 *  Elsewhere art). The key uses the same form, so a suffixed and a bare
 *  spelling are one entry, and the old suffixed misses are simply unread. */
export function albumSearchTitle(album: string): string {
  return album
    .trim()
    .replace(/\s+-\s+(?:single|ep)\s*$/i, "")
    .trim();
}
export function albumKey(artist: string, album: string): string {
  return `${artist.trim()}|${albumSearchTitle(album)}`.toLowerCase();
}
/** Whether the cache holds a verdict for this album, hit or definitive miss —
 *  for a reader that gets null from fetchAlbumInfo and must know whether that
 *  was an answer or a search that never happened (coverArt). */
export function albumInfoKnown(artist: string, album: string): boolean {
  return cache.has(albumKey(artist, album));
}
const MAX_GENRES = 4;
const MAX_CREDITS = 6;

const cache = new DiskCache<AlbumInfo>("album", CACHE_MAX);

interface MbReleaseGroup {
  id: string;
  title: string;
  score?: number;
  "first-release-date"?: string;
  "primary-type"?: string;
  "secondary-types"?: string[];
}

// Same-titled release groups tie on search score, and the plain studio album
// is not always first: Iron Maiden's "The Number of the Beast" surfaces a
// SINGLE (typed Single) and a 2001 documentary DVD (typed Album, on a video
// label). MB has no "canonical album" flag, so rank by the studio album's
// signature: primary type Album beats EP beats Single, NO secondary types
// beats decorated ones (Compilation/Live/Interview/… — DVDs and comps carry
// them), earliest first-release-date breaks what's left. When the playing
// album genuinely IS live/compilation, every same-named candidate carries
// those secondary types, so the middle rule degrades to a no-op.
const TYPE_RANK: Record<string, number> = { Album: 0, EP: 1, Single: 2 };
function rgRank(rg: MbReleaseGroup): [number, number, string] {
  return [
    TYPE_RANK[rg["primary-type"] ?? ""] ?? 3,
    (rg["secondary-types"]?.length ?? 0) > 0 ? 1 : 0,
    rg["first-release-date"] || "9999",
  ];
}
function pickReleaseGroup(candidates: MbReleaseGroup[]): MbReleaseGroup | undefined {
  return [...candidates].sort((a, b) => {
    const ra = rgRank(a);
    const rb = rgRank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return ra[i] < rb[i] ? -1 : 1;
    }
    return 0;
  })[0];
}

interface MbTag {
  name?: string;
  count?: number;
}

interface MbRelease {
  id?: string;
  date?: string;
}

interface MbCreditRel {
  type?: string;
  artist?: { name?: string };
}

export async function fetchAlbumInfo(
  artist: string,
  album: string,
  force = false,
  /** Someone asked (the panel's Album tab, an agent): the gate's urgent lane.
   *  Cover art for a list scrolling past is not urgent and waits its turn. */
  urgent = false,
): Promise<AlbumInfo | null> {
  const ask = (url: string): Promise<Fetched> => mbFetch(url, urgent);
  const key = albumKey(artist, album);
  if (!artist.trim() || !albumSearchTitle(album)) return null;
  if (!force && cache.has(key)) return cache.get(key) ?? null;

  let result: AlbumInfo | null = null;
  // Only a conclusion built purely from real answers goes into the cache.
  let definitive = true;

  const query = `releasegroup:${JSON.stringify(albumSearchTitle(album))} AND artist:${JSON.stringify(artist)}`;
  const searchGot = await ask(
    `${MB}/ws/2/release-group?query=${encodeURIComponent(query)}&fmt=json&limit=5`,
  );
  if (searchGot.kind !== "ok") {
    // couldn't even search — nothing to show, nothing to remember
    return null;
  }
  const candidates = (
    (searchGot.body as { "release-groups"?: MbReleaseGroup[] })["release-groups"] ?? []
  ).filter((rg) => (rg.score ?? 0) >= MIN_MATCH_SCORE);
  const match = pickReleaseGroup(candidates);

  if (match) {
    result = {
      title: match.title,
      year: match["first-release-date"]?.slice(0, 4) || null,
      type: match["primary-type"] ?? null,
      label: null,
      genres: [],
      credits: [],
      summary: null,
      wikipediaUrl: null,
      musicbrainzUrl: `https://musicbrainz.org/release-group/${match.id}`,
    };

    const lookupGot = await ask(
      `${MB}/ws/2/release-group/${match.id}?inc=url-rels+tags+releases&fmt=json`,
    );
    if (lookupGot.kind !== "ok") {
      definitive = false; // detail state unknown — show the partial, retry later
    } else {
      const body = lookupGot.body as {
        relations?: MbRelation[];
        tags?: MbTag[];
        releases?: MbRelease[];
      };

      result.genres = (body.tags ?? [])
        .filter((t) => t.name && (t.count ?? 0) > 0)
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
        .slice(0, MAX_GENRES)
        .map((t) => t.name as string);

      const wiki = await wikipediaFromRels(body.relations ?? []);
      result.summary = wiki.summary;
      result.wikipediaUrl = wiki.wikipediaUrl;
      if (!wiki.definitive) definitive = false;

      // The earliest dated release carries the original label and any
      // release-level credits (producer etc.). Recording-level credits would
      // cost a query burst against MB's 1 rps budget, so they stay out.
      const releases = (body.releases ?? []).filter((r) => r.id);
      releases.sort((a, b) => ((a.date || "9999") < (b.date || "9999") ? -1 : 1));
      const first = releases[0];
      if (first?.id) {
        const relGot = await ask(`${MB}/ws/2/release/${first.id}?inc=labels+artist-rels&fmt=json`);
        if (relGot.kind !== "ok") {
          definitive = false;
        } else {
          const rel = relGot.body as {
            "label-info"?: Array<{ label?: { name?: string } }>;
            relations?: MbCreditRel[];
          };
          result.label = rel["label-info"]?.find((l) => l.label?.name)?.label?.name ?? null;

          const seen = new Set<string>();
          for (const r of rel.relations ?? []) {
            const name = r.artist?.name;
            if (!r.type || !name) continue;
            const role = r.type[0].toUpperCase() + r.type.slice(1);
            const dedupe = `${role}|${name}`;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            result.credits.push({ role, name });
            if (result.credits.length >= MAX_CREDITS) break;
          }
        }
      }
    }
  }
  // no match / low score with an OK search: an answer — cache the null

  if (definitive) cache.set(key, result);
  return result;
}
