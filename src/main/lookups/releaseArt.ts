import { DiskCache } from "./diskCache";
import { MB, getJson, mbFetch } from "./mb";
import { CAA } from "./coverArt";

/**
 * ONE RELEASE'S SCANS ON THE COVER ART ARCHIVE (0.17.0, export for an agent, under fill): the back
 * cover, the booklet's pages, the disc and the tray, the richest record of how a band dressed a
 * record. The archive holds scans per RELEASE (one pressing), and an album is a release group of
 * many, so one is chosen: the edition the owner most likely has (the library's track count), then
 * an official one, one with a back cover, the most scans, the earliest. Two requests: the
 * release group's releases from MusicBrainz (its one-a-second gate, the urgent lane, since an
 * agent waits), then the chosen release's listing from the archive. The pictures themselves are
 * fetched by the export through the app's one picture path; this keeps only the listing,
 * a settled none included (a transient failure never is).
 */

export interface ReleaseImage {
  /** The archive's types for the scan: Front, Back, Booklet, Medium, Tray and the like. */
  types: string[];
  comment: string | null;
  /** The 1200 px rendering where the archive has one, else its largest. */
  url: string;
}

export interface ReleaseArt {
  /** The chosen release's MusicBrainz page. */
  release: string;
  country: string | null;
  date: string | null;
  formats: string[];
  tracks: number | null;
  images: ReleaseImage[];
}

interface MbRelease {
  id: string;
  status?: string | null;
  country?: string | null;
  date?: string | null;
  media?: Array<{ format?: string | null; "track-count"?: number }>;
  "cover-art-archive"?: { artwork?: boolean; count?: number; back?: boolean };
}

interface CaaImage {
  types?: string[];
  comment?: string;
  image?: string;
  thumbnails?: Record<string, string>;
}

/** Scans that aren't the record as released: the archive keeps them, the export leaves them. */
const SKIPPED = new Set(["Raw/Unedited", "Watermark"]);
/** The order a reader looks through a record in. */
const TYPE_ORDER = [
  "Front",
  "Back",
  "Booklet",
  "Medium",
  "Tray",
  "Obi",
  "Spine",
  "Liner",
  "Track",
  "Sticker",
  "Poster",
];
/** At most this many scans from one release (a box set's booklet runs to dozens). */
export const RELEASE_IMAGES_MAX = 24;

/** The archive lists its pictures under plain http, which costs a redirect more than https (four
 *  in all, past the picture fetch's three) and sends the first hops in the clear, naming the
 *  release; the same address over https answers in three. */
const secure = (url: string): string =>
  url.replace(/^http:\/\/coverartarchive\.org\//i, "https://coverartarchive.org/");

const tracksOf = (r: MbRelease): number =>
  (r.media ?? []).reduce((n, m) => n + (m["track-count"] ?? 0), 0);

/** The release whose scans stand for the album: see the file's note for the order. */
export function chooseRelease(releases: MbRelease[], tracks: number | null): MbRelease | null {
  const scanned = releases.filter(
    (r) => r["cover-art-archive"]?.artwork === true && (r["cover-art-archive"].count ?? 0) > 0,
  );
  const rank = (r: MbRelease): number[] => [
    tracks != null && tracksOf(r) === tracks ? 1 : 0,
    r.status === "Official" ? 1 : 0,
    r["cover-art-archive"]?.back ? 1 : 0,
    r["cover-art-archive"]?.count ?? 0,
  ];
  const byRank = (a: MbRelease, b: MbRelease): number => {
    const x = rank(a);
    const y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    // the earliest pressing; one with no date last
    return (a.date || "9999").localeCompare(b.date || "9999");
  };
  return [...scanned].sort(byRank)[0] ?? null;
}

/** A release's listing as the export uses it: the record's own scans, in reading order. */
export function imagesOf(listing: { images?: CaaImage[] }): ReleaseImage[] {
  const order = (types: string[]): number => {
    const at = TYPE_ORDER.findIndex((t) => types.includes(t));
    return at < 0 ? TYPE_ORDER.length : at;
  };
  return (listing.images ?? [])
    .filter((i) => !(i.types ?? []).some((t) => SKIPPED.has(t)))
    .map((i) => ({
      types: i.types?.length ? i.types : ["Other"],
      comment: i.comment?.trim() || null,
      url: secure(i.thumbnails?.["1200"] ?? i.thumbnails?.large ?? i.image ?? ""),
    }))
    .filter((i) => i.url !== "")
    .map((img, index) => ({ img, index }))
    .sort((a, b) => order(a.img.types) - order(b.img.types) || a.index - b.index)
    .map(({ img }) => img)
    .slice(0, RELEASE_IMAGES_MAX);
}

const cache = new DiskCache<ReleaseArt>("releaseart", 200);
const keyOf = (releaseGroup: string, tracks: number | null): string =>
  `${releaseGroup}|${tracks ?? ""}`;

/** The cache's answer without asking anyone: the scans, null for a settled none, or undefined
 *  when nothing is known (an export without fill reads only this). */
export function cachedReleaseArt(
  releaseGroup: string,
  tracks: number | null,
): ReleaseArt | null | undefined {
  const key = keyOf(releaseGroup, tracks);
  return cache.has(key) ? (cache.get(key) ?? null) : undefined;
}

/** The chosen release's scans for a release group, null when it has none (settled), or
 *  "unreachable" when MusicBrainz or the archive didn't answer. */
export async function fetchReleaseArt(
  releaseGroup: string,
  tracks: number | null,
): Promise<ReleaseArt | null | "unreachable"> {
  const key = keyOf(releaseGroup, tracks);
  if (cache.has(key)) return cache.get(key) ?? null;
  const listed = await mbFetch(
    `${MB}/ws/2/release?release-group=${encodeURIComponent(releaseGroup)}&inc=media&fmt=json&limit=100`,
    true,
  );
  if (listed.kind === "error") return "unreachable";
  const chosen =
    listed.kind === "ok"
      ? chooseRelease((listed.body as { releases?: MbRelease[] }).releases ?? [], tracks)
      : null;
  if (!chosen) {
    cache.set(key, null);
    return null;
  }
  const scans = await getJson("caa", `${CAA}/release/${encodeURIComponent(chosen.id)}`);
  if (scans.kind === "error") return "unreachable";
  const images = scans.kind === "ok" ? imagesOf(scans.body as { images?: CaaImage[] }) : [];
  const art: ReleaseArt | null =
    images.length > 0
      ? {
          release: `https://musicbrainz.org/release/${chosen.id}`,
          country: chosen.country ?? null,
          date: chosen.date || null,
          formats: (chosen.media ?? []).flatMap((m) => (m.format ? [m.format] : [])),
          tracks: tracksOf(chosen) || null,
          images,
        }
      : null;
  cache.set(key, art);
  return art;
}
