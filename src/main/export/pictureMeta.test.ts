import { describe, expect, it } from "vitest";
import { withoutMetadata } from "./pictureMeta";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const seg = (marker: number, body: number[]): number[] => [
  0xff,
  marker,
  (body.length + 2) >> 8,
  (body.length + 2) & 0xff,
  ...body,
];
const text = (b: Uint8Array): string => String.fromCharCode(...b);

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

  it("hands back what it can't read, and GIF as it is", () => {
    const broken = Uint8Array.from([0xff, 0xd8, 0x00, 0x01]);
    expect(withoutMetadata(broken, "image/jpeg")).toBe(broken);
    const gif = Uint8Array.from(ascii("GIF89a..."));
    expect(withoutMetadata(gif, "image/gif")).toBe(gif);
  });
});
