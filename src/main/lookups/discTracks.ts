// A disc's track list (0.10.0, the CD): the streamer names a disc's release by the Cover Art
// Archive picture it finds for it (…/release/<MusicBrainz release id>/…), and never lists the
// disc's tracks itself, so the release's own track list is read from MusicBrainz, through
// mb.ts's 1 rps gate. The release's media are cached whole per release id in a bounded
// disk-persisted LRU, a 404 as a definitive miss; transient failures are never cached, so the
// next ask retries. Which medium is the disc in the player is picked at read time, since a
// two-disc release answers for both discs.
import type { DiscTrack, DiscTracks } from "@shared/model";
import { DiskCache } from "./diskCache";
import { getJson, MB, mbFetch } from "./mb";

const CACHE_MAX = 200;

interface Medium {
  format: string | null;
  tracks: DiscTrack[];
}

const cache = new DiskCache<Medium[]>("disc", CACHE_MAX);

interface MbTrack {
  position?: number;
  number?: string;
  title?: string;
  length?: number | null;
}
interface MbMedium {
  format?: string | null;
  tracks?: MbTrack[];
}

function toMedia(body: unknown): Medium[] {
  const media = (body as { media?: MbMedium[] } | null)?.media ?? [];
  return media.map((m) => ({
    format: m.format ?? null,
    tracks: (m.tracks ?? []).map((t, i) => ({
      n: t.position ?? i + 1,
      title: t.title?.trim() || `Track ${t.position ?? i + 1}`,
      secs: typeof t.length === "number" && t.length > 0 ? Math.round(t.length / 1000) : null,
    })),
  }));
}

const totalSecs = (m: Medium): number | null =>
  m.tracks.every((t) => t.secs != null)
    ? m.tracks.reduce((sum, t) => sum + (t.secs ?? 0), 0)
    : null;

/** The medium that is the disc in the player: the track count must match (a release's other
 *  disc, or a different edition's running order, would name every track wrong); among equals
 *  the total length nearest the disc's own, then a CD over any other format. A release of one
 *  medium answers for a disc whose count is not known yet. */
export function pickMedium(
  media: Medium[],
  count: number | null,
  secs: number | null,
): Medium | null {
  let fits = media.filter((m) => m.tracks.length === count);
  if (count == null && media.length === 1) fits = media;
  const off = (m: Medium): number => {
    const total = totalSecs(m);
    return secs == null || total == null ? 0 : Math.abs(total - secs);
  };
  const cd = (m: Medium): number => (/\bCD\b/i.test(m.format ?? "") ? 0 : 1);
  return [...fits].sort((a, b) => off(a) - off(b) || cd(a) - cd(b))[0] ?? null;
}

/** The disc's tracks, or null when the release is unknown, the lookup failed or no medium of
 *  the release matches the disc. `count` is the disc's track count and `secs` its length when
 *  the streamer has said. `demo` is the demo streamer's address while it is the streamer: its
 *  disc's release is on no MusicBrainz, so the demo answers in its place, outside the gate. */
export async function fetchDiscTracks(
  releaseId: string,
  count: number | null,
  secs: number | null,
  demo?: string,
): Promise<DiscTracks | null> {
  const id = releaseId.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
  let media = cache.get(id);
  if (media === undefined) {
    const path = `/ws/2/release/${id}?inc=recordings&fmt=json`;
    const got = demo
      ? await getJson("demo", `${demo}${path}`)
      : await mbFetch(`${MB}${path}`, true);
    if (got.kind === "missing") {
      cache.set(id, null);
      return null;
    }
    if (got.kind !== "ok") return null;
    media = toMedia(got.body);
    cache.set(id, media);
  }
  const medium = media ? pickMedium(media, count, secs) : null;
  return medium ? { releaseId: id, tracks: medium.tracks } : null;
}
