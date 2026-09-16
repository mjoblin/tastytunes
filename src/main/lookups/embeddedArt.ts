import { nativeImage } from "electron";
import type { EmbeddedArt, EmbeddedArtQuery } from "@shared/model";
import { DiskCache } from "./diskCache";
import { loggedFetch } from "../netlog";
import { audioResUrl } from "../media/upnpBrowser";
import { resolveContent } from "../media/resolveContent";
import { getSettings } from "../data/persist";
import { pools as indexPools } from "../media/mediaIndex";
import { albumTracksOf, type MediaNode } from "@shared/model";

/**
 * Album art from the audio file itself (0.8.0). Some media servers shrink
 * covers (minidlna caps at 160×160); the file usually carries the full
 * picture in its tags. Read a small ranged window of the file, find the
 * picture block (FLAC METADATA_BLOCK_PICTURE, ID3v2 APIC), fetch exactly the
 * picture's bytes, and hand back a display-sized JPEG plus the ORIGINAL
 * dimensions so a surface can judge it against the server's art. A cover is
 * an ALBUM's: when the track's own file carries none (a WAV in a FLAC album,
 * one untagged rip), the album's other tracks are tried in running order.
 * Cached per album on disk, negatives included: an untagged album is asked
 * once. MP4/ALAC covers (the `covr` atom) are not read yet.
 */
const CACHE_MAX = 80;
const cache = new DiskCache<EmbeddedArt | null>("embeddedart", CACHE_MAX);
const WINDOW = 128 * 1024;
const PICTURE_MAX = 16 * 1024 * 1024;
const DISPLAY_MAX_WIDTH = 1200;

/** Ranged read that survives servers ignoring Range (a 200 with the whole
 *  file): the body is streamed and cancelled once `end` is reached. */
async function readRange(url: string, start: number, end: number): Promise<Uint8Array | null> {
  const res = await loggedFetch("media-art", url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok || !res.body) return null;
  const want = end - start + 1;
  const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let got = 0;
  // a 200 means the server sent the file from byte 0: skip `start` bytes
  let skip = res.status === 206 ? 0 : start;
  while (got < want) {
    const r = await reader.read();
    if (r.done || !r.value) break;
    let v: Uint8Array = r.value;
    if (skip > 0) {
      if (v.byteLength <= skip) {
        skip -= v.byteLength;
        continue;
      }
      v = v.subarray(skip);
      skip = 0;
    }
    chunks.push(v);
    got += v.byteLength;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(got, want));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.byteLength - at);
    out.set(c.subarray(0, take), at);
    at += take;
    if (at >= out.byteLength) break;
  }
  return out;
}

const ascii = (u8: Uint8Array, at: number, n: number): string =>
  String.fromCharCode(...u8.subarray(at, at + n));
const be32 = (u8: Uint8Array, at: number): number =>
  ((u8[at] << 24) | (u8[at + 1] << 16) | (u8[at + 2] << 8) | u8[at + 3]) >>> 0;
const syncsafe = (u8: Uint8Array, at: number): number =>
  ((u8[at] & 0x7f) << 21) |
  ((u8[at + 1] & 0x7f) << 14) |
  ((u8[at + 2] & 0x7f) << 7) |
  (u8[at + 3] & 0x7f);

interface PictureAt {
  /** Absolute byte range of the picture DATA in the file. */
  start: number;
  length: number;
  /** 3 = front cover; used to prefer it over other pictures. */
  kind: number;
}

/** FLAC: walk the metadata blocks in `head` (read from byte 0); a PICTURE
 *  block (type 6) beyond the window is located from its header alone. */
function flacPicture(head: Uint8Array): PictureAt | null {
  if (head.length < 8 || ascii(head, 0, 4) !== "fLaC") return null;
  let at = 4;
  let best: PictureAt | null = null;
  for (let guard = 0; guard < 64 && at + 4 <= head.length; guard++) {
    const last = (head[at] & 0x80) !== 0;
    const type = head[at] & 0x7f;
    const len = (head[at + 1] << 16) | (head[at + 2] << 8) | head[at + 3];
    const body = at + 4;
    if (type === 6 && body + 32 <= head.length) {
      // picture type, mime, description, w, h, depth, colors, data length
      const kind = be32(head, body);
      const mimeLen = be32(head, body + 4);
      let p = body + 8 + mimeLen;
      if (p + 4 > head.length) break;
      const descLen = be32(head, p);
      p += 4 + descLen;
      if (p + 20 > head.length) break;
      const dataLen = be32(head, p + 16);
      const pic = { start: p + 20, length: dataLen, kind };
      if (kind === 3) return pic;
      best ??= pic;
    }
    if (last) break;
    at = body + len;
  }
  return best;
}

/** ID3v2 (MP3, and some FLAC/AIFF files carry one too): the APIC frame. */
function id3Picture(tag: Uint8Array): PictureAt | null {
  if (tag.length < 10 || ascii(tag, 0, 3) !== "ID3") return null;
  const major = tag[3];
  const flags = tag[5];
  const size = syncsafe(tag, 6);
  let at = 10;
  if (flags & 0x40) at += major === 4 ? syncsafe(tag, 10) : be32(tag, 10) + 4;
  const end = Math.min(tag.length, 10 + size);
  let best: PictureAt | null = null;
  while (at + 10 <= end) {
    const id = ascii(tag, at, 4);
    if (id === "\0\0\0\0") break;
    const flen = major === 4 ? syncsafe(tag, at + 4) : be32(tag, at + 4);
    const body = at + 10;
    if (flen <= 0 || body + flen > end + 0) {
      if (id === "APIC") return null; // the frame runs past what we hold
      break;
    }
    if (id === "APIC") {
      const enc = tag[body];
      let p = body + 1;
      while (p < body + flen && tag[p] !== 0) p++; // mime
      p++;
      const kind = tag[p];
      p++;
      if (enc === 1 || enc === 2) {
        while (p + 1 < body + flen && !(tag[p] === 0 && tag[p + 1] === 0)) p += 2;
        p += 2;
      } else {
        while (p < body + flen && tag[p] !== 0) p++;
        p++;
      }
      const pic = { start: p, length: body + flen - p, kind };
      if (kind === 3) return pic;
      best ??= pic;
    }
    at = body + flen;
  }
  return best;
}

/** The ID3 tag's total size from its header, so a tag larger than the window
 *  can be fetched whole. */
function id3TagSize(head: Uint8Array): number | null {
  if (head.length < 10 || ascii(head, 0, 3) !== "ID3") return null;
  return 10 + syncsafe(head, 6) + ((head[5] & 0x10) !== 0 ? 10 : 0);
}

function toDisplay(data: Uint8Array): EmbeddedArt | null {
  const img = nativeImage.createFromBuffer(Buffer.from(data));
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (width < 64 || height < 64) return null;
  const shown = width > DISPLAY_MAX_WIDTH ? img.resize({ width: DISPLAY_MAX_WIDTH }) : img;
  return {
    dataUrl: `data:image/jpeg;base64,${shown.toJPEG(88).toString("base64")}`,
    width,
    height,
  };
}

async function readEmbedded(url: string): Promise<EmbeddedArt | null> {
  const head = await readRange(url, 0, WINDOW - 1);
  if (!head) return null;
  let pic: PictureAt | null = null;
  if (ascii(head, 0, 4) === "fLaC") pic = flacPicture(head);
  else if (ascii(head, 0, 3) === "ID3") {
    const tagSize = id3TagSize(head);
    if (tagSize != null && tagSize > head.length && tagSize <= PICTURE_MAX) {
      const tag = await readRange(url, 0, tagSize - 1);
      pic = tag ? id3Picture(tag) : null;
      if (pic && tag) return toDisplay(tag.subarray(pic.start, pic.start + pic.length));
    } else pic = id3Picture(head);
  }
  if (!pic || pic.length <= 0 || pic.length > PICTURE_MAX) return null;
  const data =
    pic.start + pic.length <= head.length
      ? head.subarray(pic.start, pic.start + pic.length)
      : await readRange(url, pic.start, pic.start + pic.length - 1);
  return data ? toDisplay(data) : null;
}

const lc = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();

/** The album's tracks in running order, from the index, for a track we know
 *  by server + id — the siblings whose files may carry the cover. */
function albumSiblings(serverUdn: string, objectId: string): MediaNode[] {
  const pool = indexPools().find((p) => p.udn === serverUdn);
  if (!pool) return [];
  const track = pool.tracks.find((t) => t.id === objectId);
  if (!track?.album) return [];
  const album =
    pool.albums.find(
      (a) =>
        lc(a.title) === lc(track.album) &&
        (!track.albumArtist ||
          lc(a.artist) === lc(track.albumArtist) ||
          lc(a.artist) === lc(track.artist)),
    ) ?? pool.albums.find((a) => lc(a.title) === lc(track.album));
  return album ? albumTracksOf(album, pool) : [track];
}

export async function embeddedArtFor(
  host: string | null,
  query: EmbeddedArtQuery,
): Promise<EmbeddedArt | null> {
  if (!getSettings().artFromFiles || !host) return null;
  let target: { serverUdn: string; objectId: string } | null = null;
  if ("objectId" in query) target = query;
  else {
    const found = await resolveContent(host, query).catch(() => null);
    target = found ? { serverUdn: found.serverUdn, objectId: found.objectId } : null;
  }
  if (!target) return null; // unresolved is not a verdict about the file
  // the cover is the album's: cache by album when the index knows it
  const siblings = albumSiblings(target.serverUdn, target.objectId);
  const first = siblings[0];
  const key = first?.album
    ? `alb|${target.serverUdn}|${lc(first.albumArtist ?? first.artist)}|${lc(first.album)}`
    : `obj|${target.serverUdn}|${target.objectId}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  // the track itself first, then its siblings in running order (a few at most)
  const candidates = [
    target.objectId,
    ...siblings.map((t) => t.id).filter((id) => id !== target.objectId),
  ].slice(0, 4);
  try {
    for (const objectId of candidates) {
      const url = await audioResUrl(host, target.serverUdn, objectId);
      if (!url) continue;
      const art = await readEmbedded(url);
      if (art) {
        cache.set(key, art);
        return art;
      }
    }
    cache.set(key, null);
    return null;
  } catch {
    return null;
  }
}
