import { DiskCache } from "./diskCache";
import { getSecret } from "../data/secrets";
import { fetchArtistInfo } from "./artistInfo";
import { getJson } from "./mb";

/**
 * FANART.TV'S ARTIST PHOTOS (0.13.0 round 11; a user's report, 2026-10-25, Plex's picture editor: its
 * 1000 x 1000 artist photos are fanart.tv's). With the reader's own personal key (his test that
 * night: a personal key answers alone, so no key of ours ships: decisions/0001), kept in the
 * secrets store and sent to fanart.tv alone, in its request's query (the request log blanks it:
 * netlog redactUrl). An artist is looked up by the MusicBrainz id their artist lookup found, so
 * only with Liner notes on; the chooser offers the photos (ArtistPictureDialog), most liked first.
 * Settled answers cached per artist; a refused key or an unreachable service is not.
 */
export const FANART = process.env["TASTYTUNES_FANART_URL"] ?? "https://webservice.fanart.tv";

const cache = new DiskCache<string[]>("fanart", 1000);

/** An artist known to fanart.tv, asked when a key is checked (Radiohead). */
const CHECK_MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";

interface FanartMusic {
  artistthumb?: Array<{ url?: string; likes?: string }>;
}

const ask = (mbid: string, key: string): ReturnType<typeof getJson> =>
  getJson(
    "fanart",
    `${FANART}/v3/music/${encodeURIComponent(mbid)}?api_key=${encodeURIComponent(key)}`,
  );

/** The MusicBrainz id at the end of an artist's MusicBrainz page. */
export function mbidOf(musicbrainzUrl: string | null | undefined): string | null {
  const id = musicbrainzUrl?.split("/artist/")[1]?.split(/[?#/]/)[0] ?? "";
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}

/** The photos fanart.tv answered, most liked first, each once. */
export function photosOf(body: unknown): string[] {
  const thumbs = (body as FanartMusic | null)?.artistthumb ?? [];
  const urls = [...thumbs]
    .sort((a, b) => Number(b.likes ?? 0) - Number(a.likes ?? 0))
    .map((t) => t.url ?? "")
    .filter((u) => /^https?:\/\//.test(u));
  return [...new Set(urls)];
}

/** An artist's photos at fanart.tv; empty with no key saved, no MusicBrainz match, or none there. */
export async function fetchFanartPhotos(artist: string): Promise<string[]> {
  const key = getSecret("fanartKey");
  if (!key) return [];
  const mbid = mbidOf((await fetchArtistInfo(artist))?.musicbrainzUrl);
  if (!mbid) return [];
  if (cache.has(mbid)) return cache.get(mbid) ?? [];
  const got = await ask(mbid, key);
  // no such artist there is an answer; a refused key or a failure is not
  if (got.kind === "missing") {
    cache.set(mbid, []);
    return [];
  }
  if (got.kind !== "ok") return [];
  const photos = photosOf(got.body);
  cache.set(mbid, photos);
  return photos;
}

/** Whether fanart.tv takes a key: asked once, as it is saved. */
export async function checkFanartKey(key: string): Promise<"works" | "refused" | "unreachable"> {
  const got = await ask(CHECK_MBID, key);
  if (got.kind === "ok") return "works";
  if (got.kind === "error" && (got.status === 401 || got.status === 403)) return "refused";
  return "unreachable";
}
