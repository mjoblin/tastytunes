/**
 * DIDL-Lite → MediaNode. PURE: no Electron, no network — the corpus test
 * (dev/didl-corpus.mjs) feeds real server captures straight through this
 * module, so it must stay importable outside the app.
 *
 * Two layers live here, deliberately in one file so the seam is visible:
 *
 *   1. EXTRACTION — spec-first, tolerant: the standard DIDL-Lite vocabulary
 *      (dc:title, upnp:class, upnp:artist[@role], dc:creator, upnp:album,
 *      upnp:genre, dc:date, originalTrackNumber/DiscNumber/DiscCount,
 *      albumArtURI[@profileID], the primary <res> and its DLNA attributes),
 *      read the way the spec says, with every multi-valued field accepted
 *      both as repeated elements and as one packed value.
 *
 *   2. NODE RULES — the places where the spec is silent and servers disagree,
 *      each a named rule with a guard that is a NO-OP on a spec-clean server,
 *      keyed on the SHAPE of the data, never on the vendor. Every rule names
 *      the server that taught it (dev/upnp-survey/REPORT.md has the evidence).
 *      Pool-level rules (things that need the whole result set) live next
 *      door in reconcile.ts.
 *
 * Servers whose output shaped this file: Asset UPnP (the reference: roles,
 * "; " packing, disc×100+track), minidlna/ReadyMedia (no roles, ALBUMARTIST in
 * upnp:artist, performer in dc:creator, last repeated tag only), Gerbera
 * (upnp:date beside dc:date, "Artist - Title" search titles, upnp:composer),
 * Emby/Jellyfin (one upnp:artist element per performer, ", " creator,
 * bits/s bitrate), Universal Media Server (" / " packing, no album class),
 * MinimServer (", " packing — unsplittable — roles everywhere), Plex
 * ("Album (Year)" titles, branch-dependent DIDL).
 */
import { XMLParser } from "fast-xml-parser";
import { LOSSLESS_CODECS, type MediaFormat, type MediaNode } from "@shared/model";

export const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // dc:x and upnp:x fold into x — convenient, and the reason `date` (and any
  // future dual-namespace field) must be read array-safe: see NODE RULE dates.
  removeNSPrefix: true,
  // The SOAP Result is ESCAPED XML — every tag bracket of the inner DIDL is
  // an &lt;/&gt; entity, so a large listing (Asset's "[All Album Artists]")
  // blows straight past fast-xml-parser's default billion-laughs guard of
  // 1000 expansions ("Couldn't browse this library" on big folders). Keep
  // the guard, raise the ceilings to fit real library sizes.
  processEntities: {
    enabled: true,
    maxTotalExpansions: 5_000_000,
    maxExpandedLength: 50_000_000,
  },
});

export const asArray = <T>(v: T | T[] | undefined): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

/** Text of an element that may be a string, a number, or {'#text', '@_attr'}; null for arrays (callers asArray first). */
export const text = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return null;
  const inner = (v as Record<string, unknown>)["#text"];
  return inner == null ? null : String(inner);
};
/** First value of a possibly-repeated element — for fields that two namespaces can fold into (dc:date + upnp:date). */
const first = (v: unknown): string | null => text(asArray(v)[0]);
const attr = (el: unknown, name: string): string =>
  el != null && typeof el === "object" && !Array.isArray(el)
    ? String((el as Record<string, unknown>)[`@_${name}`] ?? "")
    : "";

// upnp:albumArtURI can be MULTI-VALUED: DLNA lets a server offer several
// sizes, one element each, tagged dlna:profileID JPEG_TN/SM/MED/LRG (Twonky,
// Serviio, UMS and friends do; Asset sends one). text() of an array is null —
// the same array trap the artist parse fell into — so such a server used to
// yield NO art at all. Take the largest profile; unranked ones keep first-seen order.
const ART_RANK: Record<string, number> = {
  JPEG_LRG: 4,
  PNG_LRG: 4,
  JPEG_MED: 3,
  PNG_MED: 3,
  JPEG_SM: 2,
  PNG_SM: 2,
  JPEG_TN: 1,
  PNG_TN: 1,
};
export const pickArt = (v: unknown): string | null => {
  let best: { url: string; rank: number } | null = null;
  for (const el of asArray(v)) {
    const url = text(el);
    if (!url) continue;
    const profile = attr(el, "dlna:profileID") || attr(el, "profileID");
    const rank = ART_RANK[profile.toUpperCase()] ?? 0;
    if (!best || rank > best.rank) best = { url, rank };
  }
  return best?.url ?? null;
};

export function parseDuration(v: string | null): number | null {
  if (!v) return null;
  const m = v.match(/^(\d+):(\d{1,2}):(\d{1,2})/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// ---------------------------------------------------------------- name lists
//
// A multi-valued name field arrives four ways (survey 2026-08-17): repeated
// elements (Gerbera, Emby, Jellyfin), packed with "; " (Asset — dBpoweramp's
// convention), packed with " / " (Universal Media Server), packed with ", "
// (MinimServer, Emby's dc:creator). The first three are safe to split; ", "
// is NOT ("Albert Collins, Robert Cray & Johnny Copeland" is one artist and
// looks identical to a packed list), so it is left whole and the lens shows
// "Daft Punk, Julian Casablancas" as one performer on such servers.
export const NAME_SEPARATOR = /\s*;\s*|\s+\/\s+/;
export const splitNames = (values: ReadonlyArray<string | null | undefined>): string[] => {
  const seen = new Map<string, string>();
  for (const v of values)
    for (const part of (v ?? "").split(NAME_SEPARATOR)) {
      const t = part.trim();
      if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    }
  return [...seen.values()];
};
/** How many distinct names a packed value carries by the ", " convention — only used where the safe separators found nothing. */
const commaCount = (v: string): number =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length;

// ---------------------------------------------------------------- <res> → format
//
// The primary <res> describes the file: protocolInfo (mime + DLNA PN),
// size, duration, bitrate, bitsPerSample, sampleFrequency, nrAudioChannels.
// Servers differ in WHICH they send (the USB server: duration only; Emby:
// duration + size; UMS/Minim/Asset: everything) and in what `bitrate` MEANS —
// see NODE RULE bitrate.
function formatOf(res: Record<string, unknown> | undefined): MediaFormat | null {
  if (!res) return null;
  const proto = text(res["@_protocolInfo"]) ?? "";
  const mime = (proto.split(":")[2] ?? "").toLowerCase();
  if (!mime.startsWith("audio/")) return null;
  const sub = mime.slice("audio/".length).replace(/^x-/, "");
  const pn = /DLNA\.ORG_PN=([A-Z0-9_]+)/i.exec(proto)?.[1]?.toUpperCase() ?? "";
  const codec =
    sub === "flac"
      ? "FLAC"
      : sub === "mpeg" || sub === "mp3"
        ? "MP3"
        : sub === "wav" || sub === "wave"
          ? "WAV"
          : sub === "l16" || sub === "l24"
            ? "PCM"
            : sub === "aiff" || sub === "aif"
              ? "AIFF"
              : sub === "ms-wma" || sub === "wma"
                ? "WMA"
                : sub === "ogg" || sub === "vorbis"
                  ? "OGG"
                  : sub === "opus"
                    ? "Opus"
                    : sub === "dsd" || sub === "dsf" || sub === "dff"
                      ? "DSD"
                      : sub === "ape"
                        ? "APE"
                        : sub === "wavpack" || sub === "wv"
                          ? "WV"
                          : sub === "mp4" || sub === "m4a" || sub === "aac" || sub === "mp4a-latm"
                            ? pn.startsWith("ALAC")
                              ? "ALAC"
                              : "AAC"
                            : sub.toUpperCase();
  const num = (k: string): number | undefined => {
    const v = Number(text(res[`@_${k}`]));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const bitrateAttr = num("bitrate");
  const size = num("size");
  const secs = parseDuration(text(res["@_duration"]));
  const fileKbps = size && secs ? Math.round((size * 8) / secs / 1000) : undefined;
  // Asset labels every .m4a AAC_ISO; a 24/96 m4a at 3 Mbps is ALAC.
  const isMp4 = ["mp4", "m4a", "aac", "mp4a-latm"].includes(sub);
  const resolvedCodec = isMp4 && (pn.startsWith("ALAC") || (fileKbps ?? 0) > 600) ? "ALAC" : codec;
  const out: MediaFormat = { codec: resolvedCodec };
  const lossless = LOSSLESS_CODECS.has(resolvedCodec);
  const bits = num("bitsPerSample");
  if (bits && lossless) out.bits = bits;
  const rate = num("sampleFrequency");
  if (rate) out.rate = rate;
  // NODE RULE bitrate (2026-08-17): the file's bitrate is size ÷ duration
  // whenever both are known — that is what every player shows, and it is
  // the one number every server agrees on. The `bitrate` attribute is
  // bytes/s per the UPnP spec (Asset, Gerbera, Plex, Minim — for a lossless
  // file Asset/Minim send the DECODED PCM rate, 176400 for 16/44.1) but
  // BITS/s on minidlna, Jellyfin and UMS; it is only a fallback, and a
  // fallback that read as more than 24 Mbps for an audio file was bits/s.
  const kbps =
    fileKbps ??
    (bitrateAttr
      ? (() => {
          const asBytes = Math.round((bitrateAttr * 8) / 1000);
          return asBytes > 24_000 ? Math.round(bitrateAttr / 1000) : asBytes;
        })()
      : undefined);
  if (kbps) out.kbps = kbps;
  if (size) out.sizeBytes = size;
  const ch = num("nrAudioChannels");
  if (ch) out.channels = ch;
  return out;
}

// ---------------------------------------------------------------- one node
function nodeOf(raw: Record<string, unknown>, isContainer: boolean): MediaNode | null {
  const id = text(raw["@_id"]);
  let title = first(raw.title)?.trim() ?? null;
  if (!id || title == null) return null;
  const res = asArray(raw.res as Record<string, unknown> | Array<Record<string, unknown>>)[0];
  const format = formatOf(res);

  // genres: repeated elements AND "Pop; Rock" packing (Asset), first-seen casing
  const genres = splitNames(asArray(raw.genre).map(text));

  // ---- artists. upnp:artist is multi-valued THREE ways, all live-observed on
  // Asset (2026-08-15, a Daft Punk track with a featured singer):
  //   <upnp:artist role="AlbumArtist">Daft Punk</upnp:artist>
  //   <upnp:artist>Daft Punk; Julian Casablancas</upnp:artist>
  //   <upnp:artist role="Composer">Thomas Bangalter; Guy-Manuel …</upnp:artist>
  // `artist` stays the display string (the performers, packed), `albumArtist`
  // is the AlbumArtist role when a server sends one, `artists` the split
  // performer list when there is more than one name — identity keys on those
  // two, never on the packed string. Composer/Conductor/… roles are not
  // performers.
  const artistEls = asArray(raw.artist);
  const roleOf = (el: unknown): string => attr(el, "role").toLowerCase();
  const roleless = artistEls.every((el) => roleOf(el) === "");
  let albumArtist = text(artistEls.find((el) => roleOf(el) === "albumartist"))?.trim() || null;
  let performerText = artistEls
    .filter((el) => ["", "performer", "artist"].includes(roleOf(el)))
    .map(text)
    .filter((v): v is string => !!v?.trim())
    .map((v) => v.trim());
  const creator = first(raw.creator)?.trim() || null;

  // NODE RULE creator-as-performer (minidlna/ReadyMedia, rig 2026-08-16): NO
  // roles at all and dc:creator disagrees with the ONE role-less upnp:artist
  // → that server put ALBUMARTIST in upnp:artist and the performer (ARTIST) in
  // dc:creator (a compilation track says "Various Artists" and names its
  // singer only as creator). Read it the way it was written. A no-op when
  // the two agree (every plain track, every server); Asset always sends the
  // role, so it never gets here.
  if (
    albumArtist == null &&
    roleless &&
    performerText.length === 1 &&
    creator != null &&
    creator.toLowerCase() !== performerText[0].toLowerCase()
  ) {
    albumArtist = performerText[0];
    performerText = [creator];
  }

  let artist: string | null =
    (performerText.length > 0 ? performerText.join("; ") : null) ??
    creator ??
    albumArtist ??
    text(artistEls[0]) ??
    null;
  let artists = splitNames([artist]);
  // NODE RULE leading-album-artist (MinimServer 2026-08-17): ", "-packed
  // performers cannot be split blind, but when the string BEGINS with the
  // track's own album artist followed by ", " ("Daft Punk, Julian
  // Casablancas" on a Daft Punk album) the split is safe — the headliner is
  // one name, the rest is the guest(s), left whole. Gives such servers their
  // guest rows in the Artists lens without ever splitting a band name.
  if (
    !isContainer &&
    artists.length === 1 &&
    albumArtist &&
    artist &&
    artist.toLowerCase().startsWith(`${albumArtist.toLowerCase()}, `)
  ) {
    const rest = artist.slice(albumArtist.length + 2).trim();
    if (rest) artists = [albumArtist, rest];
  }

  // NODE RULE container-artist (Emby, Jellyfin, MinimServer, rig 2026-08-17):
  // an ALBUM container that lists every performer on the album as its plain
  // artists ("Daft Punk", "Julian Casablancas", "Paul Williams", …) is
  // credited to its AlbumArtist role when it has one — that IS the album's
  // artist — and to "Various Artists" when it has none and the list is long
  // (≥3 names by a safe separator, ≥4 by ", " which a single band name can
  // contain: "Crosby, Stills, Nash & Young"). Without this the Artists lens
  // filed Random Access Memories under a five-name pseudo-artist and every
  // compilation under a 17-name one. Asset/minidlna containers carry one
  // name and are untouched.
  if (isContainer && artist) {
    if (albumArtist) {
      artist = albumArtist;
      artists = [albumArtist];
    } else {
      const safeNames = artists.length;
      const many = safeNames >= 3 || (safeNames === 1 && commaCount(artist) >= 4);
      if (many) {
        artist = "Various Artists";
        artists = [artist];
      }
    }
  }

  // composers: role="Composer" (Asset, Emby, Minim — packed "; " or ", " or one
  // element each) AND the non-standard <upnp:composer> element (Gerbera,
  // Jellyfin), same shapes.
  const composers = splitNames([
    ...artistEls.filter((e) => roleOf(e) === "composer").map(text),
    ...asArray(raw.composer).map(text),
  ]);

  const year = first(raw.date)?.slice(0, 4) ?? null; // NODE RULE dates: dc:date + upnp:date fold into one array (Gerbera) — the first is the release date on every server seen

  // NODE RULE title-decoration (Gerbera search results "Artist - Title";
  // Plex "Album (Year)"): a title that begins with the item's own artist
  // string plus " - ", or a container title that ends with " (YEAR)" equal
  // to its own year, is the server decorating for a flat listing — Browse of
  // the same object gives the bare title, and the index and the leaf must
  // agree on content identity. Guarded on the item's OWN fields, so a track
  // genuinely titled "Someone Else - Song" survives.
  const own = [artist, albumArtist, ...(artists ?? [])].filter((s): s is string => !!s);
  for (const name of own) {
    if (
      title.length > name.length + 3 &&
      title.toLowerCase().startsWith(`${name.toLowerCase()} - `)
    ) {
      title = title.slice(name.length + 3).trim();
      break;
    }
  }
  if (isContainer && year && title.endsWith(` (${year})`))
    title = title.slice(0, -year.length - 3).trim();

  const trackNumber =
    raw.originalTrackNumber != null ? Number(text(raw.originalTrackNumber)) : null;
  return {
    ...(composers.length > 0 ? { composers } : {}),
    ...(genres.length > 0 ? { genre: genres } : {}),
    ...(albumArtist ? { albumArtist } : {}),
    ...(artists.length > 1 ? { artists } : {}),
    id,
    parentId: text(raw["@_parentID"]),
    title,
    upnpClass: text(raw.class) ?? "",
    isContainer,
    artUrl: pickArt(raw.albumArtURI),
    artist,
    album: first(raw.album),
    year,
    trackNumber: trackNumber != null && Number.isFinite(trackNumber) ? trackNumber : null,
    // multi-disc: Asset sends both, and packs disc×100+track into the
    // track number besides — decoded by trackPosition(), never here.
    ...(raw.originalDiscNumber != null && Number.isFinite(Number(text(raw.originalDiscNumber)))
      ? { discNumber: Number(text(raw.originalDiscNumber)) }
      : {}),
    ...(raw.originalDiscCount != null && Number.isFinite(Number(text(raw.originalDiscCount)))
      ? { discCount: Number(text(raw.originalDiscCount)) }
      : {}),
    durationSecs: res ? parseDuration(text(res["@_duration"])) : null,
    ...(format ? { format } : {}),
  };
}

/** Every container and item in a DIDL-Lite document, containers first. */
export function didlToNodes(didl: string): MediaNode[] {
  const doc = parser.parse(didl) as { "DIDL-Lite"?: Record<string, unknown> };
  const root = doc["DIDL-Lite"];
  if (!root) return [];
  const containers = asArray(
    root.container as Record<string, unknown> | Array<Record<string, unknown>>,
  )
    .map((c) => nodeOf(c, true))
    .filter((n): n is MediaNode => n != null);
  const items = asArray(root.item as Record<string, unknown> | Array<Record<string, unknown>>)
    .map((i) => nodeOf(i, false))
    .filter((n): n is MediaNode => n != null);
  return [...containers, ...items];
}
