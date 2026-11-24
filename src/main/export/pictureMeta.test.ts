import { describe, expect, it } from "vitest";
import { orientationOf, withoutMetadata } from "./pictureMeta";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const seg = (marker: number, body: number[]): number[] => [
  0xff,
  marker,
  (body.length + 2) >> 8,
  (body.length + 2) & 0xff,
  ...body,
];
const text = (b: Uint8Array): string => String.fromCharCode(...b);
/** A camera's TIFF block, little-endian: its make, and the orientation `o`. */
const cameraTiff = (o: number): number[] => [
  ...ascii("II*\0"),
  8,
  0,
  0,
  0,
  2,
  0,
  // Make, ASCII, six bytes at offset 38
  0x0f,
  0x01,
  2,
  0,
  6,
  0,
  0,
  0,
  38,
  0,
  0,
  0,
  // Orientation, SHORT, one
  0x12,
  0x01,
  3,
  0,
  1,
  0,
  0,
  0,
  o,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  ...ascii("Canon\0"),
];

describe("a picture without its metadata", () => {
  it("takes a JPEG's EXIF, XMP and comments out, the picture and its color profile kept", () => {
    const jpeg = Uint8Array.from([
      0xff,
      0xd8,
      ...seg(0xe0, ascii("JFIF\0")),
      ...seg(0xe1, ascii("Exif\0\0GPS 51.5N home")),
      ...seg(0xe2, ascii("ICC_PROFILE\0profile")),
      ...seg(0xfe, ascii("shot by someone")),
      ...seg(0xdb, [1, 2, 3]),
      0xff,
      0xda,
      0,
      4,
      9,
      9,
      0x55,
      0x66,
      0xff,
      0xd9,
    ]);
    const out = withoutMetadata(jpeg, "image/jpeg");
    const s = text(out);
    expect(s).not.toContain("Exif");
    expect(s).not.toContain("someone");
    expect(s).toContain("JFIF");
    expect(s).toContain("ICC_PROFILE");
    // the scan and the end are as they were
    expect([...out.subarray(-10)]).toEqual([0xff, 0xda, 0, 4, 9, 9, 0x55, 0x66, 0xff, 0xd9]);
    expect(out.length).toBeLessThan(jpeg.length);
  });

  it("takes a PNG's text, EXIF and time chunks out", () => {
    const chunk = (type: string, data: number[]): number[] => [
      0,
      0,
      0,
      data.length,
      ...ascii(type),
      ...data,
      0,
      0,
      0,
      0,
    ];
    const png = Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
      ...chunk("tEXt", ascii("Author\0someone")),
      ...chunk("eXIf", ascii("MM\0*")),
      ...chunk("IDAT", [1, 2, 3]),
      ...chunk("IEND", []),
    ]);
    const s = text(withoutMetadata(png, "image/png"));
    expect(s).not.toContain("someone");
    expect(s).not.toContain("eXIf");
    expect(s).toContain("IHDR");
    expect(s).toContain("IDAT");
    expect(s).toContain("IEND");
  });

  it("keeps a JPEG's orientation, alone in an EXIF of its own, and ends at the end marker", () => {
    const jpeg = Uint8Array.from([
      0xff,
      0xd8,
      ...seg(0xe0, ascii("JFIF\0")),
      ...seg(0xe1, [...ascii("Exif\0\0"), ...cameraTiff(6)]),
      ...seg(0xdb, [1, 2, 3]),
      // a progressive picture: a scan, a table between scans holding FF D9 as data, another scan
      ...seg(0xda, [1, 2]),
      0x12,
      0xff,
      0x00,
      0x34,
      0xff,
      0xd3,
      0x56,
      ...seg(0xc4, [0xff, 0xd9, 7]),
      ...seg(0xda, [3, 4]),
      0x78,
      0xff,
      0xd9,
      // a motion photo's video after the picture
      ...ascii("ftypmp42 video of the street"),
    ]);
    const out = withoutMetadata(jpeg, "image/jpeg");
    const s = text(out);
    expect(s).not.toContain("Canon");
    expect(s).not.toContain("street");
    const app1 = s.indexOf("Exif\0\0");
    expect(app1).toBeGreaterThan(0);
    const tiff = out.subarray(app1 + 6, app1 + 6 + 26);
    expect(orientationOf(tiff)).toBe(6);
    // one entry in the directory, the orientation
    expect((tiff[8] << 8) | tiff[9]).toBe(1);
    // the scans, the table between them and the end marker are all there
    expect([...out.subarray(-3)]).toEqual([0x78, 0xff, 0xd9]);
    expect(s).toContain(text(Uint8Array.from(seg(0xc4, [0xff, 0xd9, 7]))));
  });

  it("drops an EXIF whose orientation is the default, and keeps a WebP's orientation", () => {
    const upright = Uint8Array.from([
      0xff,
      0xd8,
      ...seg(0xe1, [...ascii("Exif\0\0"), ...cameraTiff(1)]),
      ...seg(0xda, [1, 2]),
      0x12,
      0xff,
      0xd9,
    ]);
    expect(text(withoutMetadata(upright, "image/jpeg"))).not.toContain("Exif");
    const riff = (type: string, data: number[]): number[] => [
      ...ascii(type),
      data.length & 0xff,
      (data.length >> 8) & 0xff,
      0,
      0,
      ...data,
      ...(data.length % 2 ? [0] : []),
    ];
    const body = [
      ...riff("VP8X", [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ...riff("VP8 ", [1, 2, 3, 4]),
      ...riff("EXIF", cameraTiff(8)),
      ...riff("XMP ", ascii("<x:xmpmeta>someone</x:xmpmeta>")),
    ];
    const size = body.length + 4;
    const webp = Uint8Array.from([
      ...ascii("RIFF"),
      size & 0xff,
      (size >> 8) & 0xff,
      0,
      0,
      ...ascii("WEBP"),
      ...body,
    ]);
    const out = withoutMetadata(webp, "image/webp");
    const s = text(out);
    expect(s).not.toContain("Canon");
    expect(s).not.toContain("someone");
    const at = s.indexOf("EXIF");
    expect(orientationOf(out.subarray(at + 8, at + 8 + 26))).toBe(8);
    // the flags still promise the EXIF, no longer the XMP
    expect(out[20] & 0x0c).toBe(0x08);
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
  });

  it("hands back what it can't read, and GIF as it is", () => {
    const broken = Uint8Array.from([0xff, 0xd8, 0x00, 0x01]);
    expect(withoutMetadata(broken, "image/jpeg")).toBe(broken);
    const gif = Uint8Array.from(ascii("GIF89a..."));
    expect(withoutMetadata(gif, "image/gif")).toBe(gif);
  });
});
