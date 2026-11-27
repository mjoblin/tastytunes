// SONG COVERS ON RADIO (0.17.0). A station announces its song as one "Artist - Song" title and
// sends its own logo as the picture, whatever plays. With covers on radio on, the big surfaces ask
// for the song's cover: a MusicBrainz recording search by the song and its lead artist, through
// mb.ts's one-a-second gate on the urgent lane (the song is playing now), then the Cover Art
// Archive's front cover for the release group the recording first came out on.
//
// A wrong cover is worse than the station's logo, so a match is strict: the recording's title
// must be the song's (letters and digits compared, a version's note in brackets aside), and its
// artist must be the station's lead artist. Anything else (a show's name, an ad, a station
// that puts the song first) finds nothing, and the logo stays. Of the recording's releases the
// official album comes first, then a single, then an EP, the earliest of each; compilations,
// live records and mixes never stand for a song, and neither does a record not credited to the
// song's own artist (a various-artists album the archive never tagged a compilation).
//
// Cached as a data URL in a bounded disk LRU, INCLUDING definitive misses (no recording matched,
// or no cover for any of its albums), so a station's rotation is asked once; a failed search or
// fetch is nobody's verdict and is asked again. Gated at the IPC layer by the Missing album art
// switch (whether anything is asked) and Song covers on radio (whether the logo gives way).
import { DiskCache } from "./diskCache";
import { MB, mbFetch } from "./mb";
import { CAA } from "./coverArt";
import { loggedFetch } from "../netlog";
import { getSettings } from "../data/persist";

/** Bounded low: entries are whole images as data URLs (~100 KB each). */
const CACHE_MAX = 200;
/** The credits lookup's bar for a search hit (lookups/trackInfo). */
const MIN_MATCH_SCORE = 75;
/** Release groups tried for a cover before the song counts as having none. */
const GROUPS_MAX = 3;
const FETCH_MS = 10_000;
/** The choosing rules' version, in every cache key: raised when they change what a song shows. */
const RULES = 2;

const cache = new DiskCache<string | null>("radiocover", CACHE_MAX);
const asking = new Map<string, Promise<string | null>>();

interface MbCredit {
  name?: string;
  joinphrase?: string;
  artist?: { name?: string };
}
interface MbRelease {
  status?: string | null;
  date?: string | null;
  /** The release's own credit, where the search gives one (a compilation's "Various Artists"). */
  "artist-credit"?: MbCredit[];
  "release-group"?: { id?: string; "primary-type"?: string | null; "secondary-types"?: string[] };
}
export interface MbRecording {
  id: string;
  title: string;
  score?: number;
  video?: boolean | null;
  "artist-credit"?: MbCredit[];
  releases?: MbRelease[];
}

/** Letters and digits only, lower-cased, marks dropped: "Hey, Soul Sister" and "Hey Soul
 *  Sister" agree, and so do "Beyoncé" and "Beyonce". */
export const looseKey = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

/** The song without a closing version's note: "Love Story (Taylor's Version)" → "Love Story",
 *  "Something Better [Cydelix Remix]" → "Something Better". A note that opens the title stays. */
export const withoutVersion = (s: string): string =>
  s.replace(/\s*[([][^()[\]]*[)\]]\s*$/u, "").trim() || s.trim();

/** The first artist a station credits: "Sam Fender feat. Olivia Dean" → "Sam Fender", "Lady
 *  Gaga & Bruno Mars" → "Lady Gaga", "ROSE, Bruno Mars" → "ROSE". A band whose name holds an
 *  ampersand or a comma still matches (see creditsLead). */
export const leadArtist = (artist: string): string =>
  artist.split(/\s+(?:feat\.?|ft\.?|featuring|with|x|vs\.?)\s+|\s*[&,+]\s*/iu)[0]?.trim() ||
  artist.trim();

/** Whether a recording's credit names the station's lead artist: one of its artists by name,
 *  or the credit as written starting with it ("Mumford & Sons" for "Mumford"). */
function creditsLead(credit: MbCredit[] | undefined, lead: string): boolean {
  if (!lead || !credit?.length) return false;
  const phrase = looseKey(
    credit.map((a) => `${a.name ?? a.artist?.name ?? ""}${a.joinphrase ?? ""}`).join(""),
  );
  return (
    credit.some(
      (a) => looseKey(a.name ?? "") === lead || looseKey(a.artist?.name ?? "") === lead,
    ) || phrase.startsWith(lead)
  );
}

const TYPE_RANK: Record<string, number> = { album: 0, single: 1, ep: 2 };
const NEVER = new Set(["compilation", "live", "dj-mix", "mixtape/street"]);

/**
 * The release groups whose front cover may stand for the song, best first (at most GROUPS_MAX):
 * from the recordings that match strictly (see the file's note), official releases first, then
 * an album, a single, an EP, then anything else, the earliest of each. A recording titled
 * exactly as the station has it beats one that matches only without the version's note, so
 * "Love Story (Taylor's Version)" never shows the first record's cover.
 */
export function coverGroups(recordings: MbRecording[], artist: string, song: string): string[] {
  const lead = looseKey(leadArtist(artist));
  const title = looseKey(song);
  const bare = looseKey(withoutVersion(song));
  const credited = recordings.filter(
    (r) => !r.video && (r.score ?? 0) >= MIN_MATCH_SCORE && creditsLead(r["artist-credit"], lead),
  );
  const exact = credited.filter((r) => looseKey(r.title) === title);
  const matched = exact.length
    ? exact
    : credited.filter((r) => looseKey(withoutVersion(r.title)) === bare);
  const rows: Array<{ id: string; official: number; rank: number; date: string }> = [];
  for (const r of matched) {
    for (const rel of r.releases ?? []) {
      const rg = rel["release-group"];
      if (!rg?.id) continue;
      if ((rg["secondary-types"] ?? []).some((t) => NEVER.has(t.toLowerCase()))) continue;
      // the artist's own record only: a various-artists album the archive never tagged a
      // compilation, or another artist's, never stands for the song
      if (rel["artist-credit"] && !creditsLead(rel["artist-credit"], lead)) continue;
      rows.push({
        id: rg.id,
        official: rel.status?.toLowerCase() === "official" ? 0 : 1,
        rank: TYPE_RANK[(rg["primary-type"] ?? "").toLowerCase()] ?? 3,
        date: rel.date || "9999",
      });
    }
  }
  rows.sort((a, b) => a.official - b.official || a.rank - b.rank || a.date.localeCompare(b.date));
  return [...new Set(rows.map((r) => r.id))].slice(0, GROUPS_MAX);
}

const recordingsOf = (body: unknown): MbRecording[] =>
  (body as { recordings?: MbRecording[] } | null)?.recordings ?? [];

function search(lead: string, song: string) {
  const query = `recording:${JSON.stringify(song)} AND artist:${JSON.stringify(lead)}`;
  return mbFetch(`${MB}/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=10`, true);
}

async function find(artist: string, song: string, key: string): Promise<string | null> {
  const lead = leadArtist(artist);
  let got = await search(lead, song);
  if (got.kind !== "ok") return null; // no answer: nothing to show, nothing to remember
  let groups = coverGroups(recordingsOf(got.body), artist, song);
  // a version's note the archive's title doesn't carry: asked once more without it
  const bare = withoutVersion(song);
  if (groups.length === 0 && bare !== song) {
    got = await search(lead, bare);
    if (got.kind !== "ok") return null;
    groups = coverGroups(recordingsOf(got.body), artist, bare);
  }
  let definitive = true;
  for (const id of groups) {
    try {
      const res = await loggedFetch("caa", `${CAA}/release-group/${id}/front-500`, {
        signal: AbortSignal.timeout(FETCH_MS),
      });
      if (res.status === 404) continue; // this album has no cover: the next may
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!res.ok || !type.startsWith("image/")) {
        definitive = false;
        continue;
      }
      const url = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
      cache.set(key, url);
      return url;
    } catch {
      definitive = false; // network trouble is never a verdict
    }
  }
  if (definitive) cache.set(key, null);
  return null;
}

/** The song's cover as a data URL, or null (no match, no cover, or no answer yet). */
export function fetchRadioCover(artist: string, song: string): Promise<string | null> {
  const a = artist.trim();
  const s = song.trim();
  if (!a || !s) return Promise.resolve(null);
  // the choosing rules' version leads the key: a song chosen under older rules is chosen again,
  // and its old entry ages out of the LRU
  const key = `${RULES}|${looseKey(a)}|${looseKey(s)}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  let p = asking.get(key);
  if (!p) {
    p = find(a, s, key).finally(() => asking.delete(key));
    asking.set(key, p);
  }
  return p;
}

/** The song's cover when it is wanted: the Missing album art switch on (whether anything is asked)
 *  and Song covers on radio on (whether the logo gives way); either off, null and no request.
 *  The window's call and a page's route both come here. */
export function wantedRadioCover(artist: string, song: string): Promise<string | null> {
  const s = getSettings();
  return s.albumArtLookup && s.radioCovers ? fetchRadioCover(artist, song) : Promise.resolve(null);
}
