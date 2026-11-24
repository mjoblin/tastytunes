/**
 * A PICTURE WITHOUT ITS METADATA (0.17.0, export for an agent, redacted): a redacted export hands
 * on its pictures with nothing a camera or an editor wrote into them (EXIF and its place and
 * date, XMP, IPTC, comments, text chunks), the picture itself untouched. Pure, no dependency:
 * the formats' own segment and chunk layouts. A file it can't read is handed back as it came,
 * since a picture that won't open is worse than one with its tags; GIF and SVG pass as they are.
 *
 * ONE TAG STAYS: a photo stored on its side is shown upright by its EXIF orientation, which the
 * window follows, so a JPEG or WebP whose orientation isn't the default keeps a new EXIF holding
 * that tag and nothing else. A JPEG ends at its end marker: what a phone appends after it (a
 * motion photo's video, a second picture) goes too.
 */

const EXIF_HEAD = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"
const ascii = (t: string): number[] => [...t].map((c) => c.charCodeAt(0));

/** The orientation (2 to 8) in a TIFF block's first directory, or null for the default or none. */
export function orientationOf(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return null;
  const count = view.getUint16(ifd, little);
  for (let e = 0; e < count; e++) {
    const at = ifd + 2 + e * 12;
    if (at + 12 > tiff.length) return null;
    if (view.getUint16(at, little) !== 0x0112) continue;
    const value = view.getUint16(at + 8, little);
    return value >= 2 && value <= 8 ? value : null;
  }
  return null;
}

/** A TIFF block with one directory of one entry, the orientation (big-endian, 26 bytes). */
function orientationTiff(o: number): number[] {
  return [
    0x4d,
    0x4d,
    0,
    0x2a,
    0,
    0,
    0,
    8,
    0,
    1,
    0x01,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    o,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
}

/** Where a JPEG's picture ends, from its first scan: past the end marker, walking each scan's
 *  coded data (a 0xFF in it is followed by 0x00 or a restart marker) and the tables a
 *  progressive picture puts between its scans; the file's end when it has none. */
function jpegEnd(b: Uint8Array, sos: number): number {
  let i = sos;
  while (i + 3 < b.length) {
    const m = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return b.length;
    i += 2 + len;
    if (m === 0xda)
      for (; i + 1 < b.length; i++) {
        const next = b[i + 1];
        if (b[i] === 0xff && next !== 0 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) break;
      }
    // a marker: its fill bytes, then the end or another segment
    while (i + 1 < b.length && b[i] === 0xff && b[i + 1] === 0xff) i += 1;
    if (i + 1 >= b.length || b[i] !== 0xff) return b.length;
    if (b[i + 1] === 0xd9) return i + 2;
  }
  return b.length;
}

const JPEG_KEEP = new Set([
  0xe0, // APP0: JFIF, the picture's own density
  0xe2, // APP2: the color profile (ICC_PROFILE)
  0xee, // APP14: Adobe's color transform, which a CMYK picture needs to open right
]);

function jpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return b;
    const m = b[i + 1];
    if (m === 0xff) {
      i += 1;
      continue;
    }
    // the scan: everything from here to the end marker is the picture itself
    if (m === 0xda) {
      out.push(b.subarray(i, jpegEnd(b, i)));
      return concat(out);
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 3 >= b.length) return b;
    const len = (b[i + 2] << 8) | b[i + 3];
    const end = i + 2 + len;
    if (len < 2 || end > b.length) return b;
    const app = m >= 0xe0 && m <= 0xef;
    const icc = m === 0xe2 && String.fromCharCode(...b.subarray(i + 4, i + 15)) === "ICC_PROFILE";
    const dropped = m === 0xfe || (app && (!JPEG_KEEP.has(m) || (m === 0xe2 && !icc)));
    if (!dropped) out.push(b.subarray(i, end));
    else if (m === 0xe1 && EXIF_HEAD.every((x, k) => b[i + 4 + k] === x)) {
      const o = orientationOf(b.subarray(i + 10, end));
      if (o != null) {
        const body = [...EXIF_HEAD, ...orientationTiff(o)];
        out.push(Uint8Array.from([0xff, 0xe1, 0, body.length + 2, ...body]));
      }
    }
    i = end;
  }
  return b;
}

const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

function png(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (i + 8 <= b.length) {
    const len = view.getUint32(i);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > b.length) return b;
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") return concat(out);
  }
  return b;
}

/** The orientation in a WebP's EXIF chunk (its TIFF block, after "Exif\0\0" when a writer put
 *  one there), or null. */
function webpOrientation(b: Uint8Array): number | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 12; i + 8 <= b.length;) {
    const size = view.getUint32(i + 4, true);
    if (String.fromCharCode(...b.subarray(i, i + 4)) === "EXIF" && i + 8 + size <= b.length) {
      const data = b.subarray(i + 8, i + 8 + size);
      const headed = EXIF_HEAD.every((x, k) => data[k] === x);
      return orientationOf(headed ? data.subarray(6) : data);
    }
    i += 8 + size + (size % 2);
  }
  return null;
}

function webp(b: Uint8Array): Uint8Array {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const kept: Uint8Array[] = [];
  const o = webpOrientation(b);
  let i = 12;
  while (i + 8 <= b.length) {
    const type = String.fromCharCode(...b.subarray(i, i + 4));
    const size = view.getUint32(i + 4, true);
    const end = i + 8 + size + (size % 2);
    if (i + 8 + size > b.length) return b;
    if (type === "VP8X") {
      const chunk = b.slice(i, Math.min(end, b.length));
      // the flags no longer promise what was taken out (EXIF 0x08, XMP 0x04), the orientation's
      // EXIF excepted
      chunk[8] &= o != null ? ~0x04 : ~0x0c;
      kept.push(chunk);
    } else if (type === "EXIF") {
      // 26 bytes, even: no pad byte
      if (o != null)
        kept.push(Uint8Array.from([...ascii("EXIF"), 26, 0, 0, 0, ...orientationTiff(o)]));
    } else if (type !== "XMP ") kept.push(b.subarray(i, Math.min(end, b.length)));
    i = end;
  }
  const body = concat(kept);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 12));
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  return concat([head, body]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The picture's bytes with its metadata taken out, by its type. */
export function withoutMetadata(bytes: Uint8Array, type: string): Uint8Array {
  try {
    if (type === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
    if (type === "image/png" && bytes[0] === 0x89 && bytes[1] === 0x50) return png(bytes);
    if (
      type === "image/webp" &&
      String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
    )
      return webp(bytes);
  } catch {
    // a picture this can't read goes as it came
  }
  return bytes;
}
