import type { PictureOffer } from "@shared/model";
import { DiskCache } from "./diskCache";
import { fetchArtistInfo } from "./artistInfo";
import { getJson, WD, WIKI } from "./mb";
import { nameKey } from "@shared/keys";

// MORE PHOTOS TO CHOOSE FROM (0.14.0, his call 2026-10-25 on a user's email, Plex's picture
// editor): the photos in the artist's Wikimedia Commons category, found the way the article is
// (MusicBrainz → Wikipedia), then its Wikidata item's Commons category (P373), no key needed
// (decisions/0001). a-ha's holds 36 where its article shows a few. Each offer carries its full
// size, shown under its tile, and its file page. Cached per artist, settled answers only.

export const COMMONS = process.env["TASTYTUNES_COMMONS_URL"] ?? "https://commons.wikimedia.org";

/** At most this many photos offered (a busy category holds hundreds). */
const COMMONS_MAX = 60;
/** The tile's thumbnail width and the chosen picture's: Wikimedia's standard sizes. */
const THUMB_PX = 330;
const CHOSEN_PX = 1280;
/** Smaller than this either way is no artist's picture (a logo, an icon, a scan's crop). */
const MIN_PX = 300;
const PHOTO = /^image\/(jpeg|png|webp)$/;

const cache = new DiskCache<PictureOffer[]>("artistCommons", 1000);
type Sized = { width: number; height: number; page: string | null };
/** Each Wikimedia file's size by its name, settled answers only (null: the API knows no such file). */
const sizeCache = new DiskCache<Sized | null>("wikimediaSizes", 4000);

interface ImageInfo {
  url?: string;
  width?: number;
  height?: number;
  mime?: string;
  thumburl?: string;
  descriptionurl?: string;
}

/** A Wikimedia thumbnail of another width: its path names the width ("/330px-"). */
function atWidth(thumb: string, px: number): string {
  return thumb.replace(/\/\d+px-([^/]+)$/, `/${px}px-$1`);
}

/** One file's offer: the 1280-wide picture to choose (the original when it is no wider). */
function offerOf(ii: ImageInfo): PictureOffer | null {
  const { url, width, height, mime, thumburl } = ii;
  if (!url || !thumburl || !width || !height || !PHOTO.test(mime ?? "")) return null;
  if (width < MIN_PX || height < MIN_PX) return null;
  return {
    url: width > CHOSEN_PX ? atWidth(thumburl, CHOSEN_PX) : url,
    thumb: thumburl,
    width,
    height,
    page: ii.descriptionurl ?? null,
  };
}

/** The Commons category of an article's Wikidata item: null when it has none, false when a
 *  service could not be asked (not a settled answer). */
async function categoryOf(articleTitle: string): Promise<string | null | false> {
  const props = await getJson(
    "wikipedia",
    `${WIKI}/w/api.php?action=query&prop=pageprops&ppprop=wikibase_item&redirects=1&format=json&titles=${encodeURIComponent(articleTitle)}`,
  );
  if (props.kind === "error") return false;
  const pages =
    props.kind === "ok"
      ? ((
          props.body as {
            query?: { pages?: Record<string, { pageprops?: { wikibase_item?: string } }> };
          }
        ).query?.pages ?? {})
      : {};
  const qid = Object.values(pages)[0]?.pageprops?.wikibase_item;
  if (!qid || !/^Q\d+$/.test(qid)) return null;
  const entity = await getJson("wikidata", `${WD}/wiki/Special:EntityData/${qid}.json`);
  if (entity.kind === "error") return false;
  if (entity.kind !== "ok") return null;
  const e = Object.values(
    (entity.body as { entities?: Record<string, unknown> }).entities ?? {},
  )[0] as
    | {
        claims?: { P373?: Array<{ mainsnak?: { datavalue?: { value?: unknown } } }> };
        sitelinks?: { commonswiki?: { title?: string } };
      }
    | undefined;
  const p373 = e?.claims?.P373?.[0]?.mainsnak?.datavalue?.value;
  if (typeof p373 === "string" && p373.trim()) return p373.trim();
  const site = e?.sitelinks?.commonswiki?.title ?? "";
  return site.startsWith("Category:") ? site.slice("Category:".length) : null;
}

/** The photos in an artist's Commons category, each with its size; empty with none found. */
export async function fetchCommonsPhotos(artist: string): Promise<PictureOffer[]> {
  const key = nameKey(artist);
  if (cache.has(key)) return cache.get(key) ?? [];
  const info = await fetchArtistInfo(artist);
  const article = info?.wikipediaUrl
    ? decoded((info.wikipediaUrl.split("/wiki/")[1] ?? "").split(/[?#]/)[0])
    : "";
  if (!article) return [];
  const category = await categoryOf(article);
  if (category === false) return [];
  if (!category) {
    cache.set(key, []);
    return [];
  }
  const got = await getJson(
    "commons",
    `${COMMONS}/w/api.php?action=query&generator=categorymembers&gcmtype=file&gcmlimit=100&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=${THUMB_PX}&format=json&gcmtitle=${encodeURIComponent(`Category:${category}`)}`,
  );
  if (got.kind === "error") return [];
  const pages =
    got.kind === "ok"
      ? ((
          got.body as {
            query?: { pages?: Record<string, { title?: string; imageinfo?: ImageInfo[] }> };
          }
        ).query?.pages ?? {})
      : {};
  const offers = Object.values(pages)
    .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""))
    .map((p) => (p.imageinfo?.[0] ? offerOf(p.imageinfo[0]) : null))
    .filter((o): o is PictureOffer => o != null)
    .slice(0, COMMONS_MAX);
  cache.set(key, offers);
  return offers;
}

/** A URL's part as text; a malformed escape stays as it was rather than throwing. */
function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A Wikimedia file's name from any of its URLs (thumbnail or original), spaces for
 *  underscores, as the API titles it: the same photo on the article and in the category is
 *  offered once, and the article's images are sized by it. A thumbnail of a drawing or a scan
 *  ("x.svg.png", "x.tif.jpg") names the file it was made from. */
export function wikimediaFile(url: string): string {
  const last = url.split(/[?#]/)[0].split("/").pop() ?? "";
  return decoded(last)
    .replace(/^\d+px-/, "")
    .replace(/\.(svg|tiff?|pdf|gif|webp)\.(png|jpe?g)$/i, ".$1")
    .replace(/_/g, " ");
}

/** The full size and file page of Wikimedia images given by any of their URLs (the article's
 *  images, which its media list hands out as thumbnails without a size), asked fifty at a time;
 *  a file the answer leaves out is simply unsized. */
export async function fetchWikimediaSizes(urls: readonly string[]): Promise<Map<string, Sized>> {
  const out = new Map<string, Sized>();
  const files = [...new Set(urls.map(wikimediaFile).filter(Boolean))];
  const ask: string[] = [];
  for (const f of files) {
    if (!sizeCache.has(f)) ask.push(f);
    else {
      const known = sizeCache.get(f);
      if (known) out.set(f, known);
    }
  }
  for (let i = 0; i < ask.length; i += 50) {
    const batch = ask.slice(i, i + 50);
    const got = await getJson(
      "wikipedia",
      `${WIKI}/w/api.php?action=query&prop=imageinfo&iiprop=size|url&format=json&titles=${encodeURIComponent(batch.map((f) => `File:${f}`).join("|"))}`,
    );
    if (got.kind !== "ok") continue;
    const pages =
      (
        got.body as {
          query?: { pages?: Record<string, { title?: string; imageinfo?: ImageInfo[] }> };
        }
      ).query?.pages ?? {};
    const found = new Set<string>();
    for (const p of Object.values(pages)) {
      const ii = p.imageinfo?.[0];
      const name = (p.title ?? "").replace(/^File:/, "");
      if (!ii?.width || !ii.height || !name) continue;
      const sized = { width: ii.width, height: ii.height, page: ii.descriptionurl ?? null };
      out.set(name, sized);
      sizeCache.set(name, sized);
      found.add(name);
    }
    for (const f of batch) if (!found.has(f)) sizeCache.set(f, null);
  }
  return out;
}
