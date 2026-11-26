import { describe, expect, it } from "vitest";
import { pictureType } from "./pictureType";

const bytes = (...b: number[]): Uint8Array => {
  const out = new Uint8Array(16);
  out.set(b);
  return out;
};
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("a picture's type from its first bytes", () => {
  it("knows each format by its signature", () => {
    expect(pictureType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(pictureType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe("image/png");
    expect(pictureType(text("GIF89a"))).toBe("image/gif");
    expect(pictureType(text("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(pictureType(bytes(0, 0, 1, 0))).toBe("image/x-icon");
    expect(pictureType(text('<?xml version="1.0"?><svg/>'))).toBe("image/svg+xml");
  });

  it("names nothing it doesn't know", () => {
    expect(pictureType(text("fLaC"))).toBeNull();
    expect(pictureType(new Uint8Array(0))).toBeNull();
  });
});
