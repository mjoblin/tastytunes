/**
 * A PICTURE WITHOUT ITS METADATA (0.17.0, export for an agent, redacted): a redacted export hands
 * on its pictures with nothing a camera or an editor wrote into them (EXIF and its place and
 * date, XMP, IPTC, comments, text chunks), the picture itself untouched. Pure, no dependency:
 * the formats' own segment and chunk layouts. A file it can't read is handed back as it came,
 * since a picture that won't open is worse than one with its tags; GIF and SVG pass as they are.
 */

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
    // the scan: everything from here is the picture itself
    if (m === 0xda) {
      out.push(b.subarray(i));
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

function webp(b: Uint8Array): Uint8Array {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const kept: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = String.fromCharCode(...b.subarray(i, i + 4));
    const size = view.getUint32(i + 4, true);
    const end = i + 8 + size + (size % 2);
    if (i + 8 + size > b.length) return b;
    if (type === "VP8X") {
      const chunk = b.slice(i, Math.min(end, b.length));
      // the flags no longer promise what was taken out (EXIF 0x08, XMP 0x04)
      chunk[8] &= ~0x0c;
      kept.push(chunk);
    } else if (type !== "EXIF" && type !== "XMP ")
      kept.push(b.subarray(i, Math.min(end, b.length)));
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
