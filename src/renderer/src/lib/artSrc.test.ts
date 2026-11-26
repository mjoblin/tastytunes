import { describe, expect, it } from "vitest";
import { artSrc } from "./artSrc";

const own = "/art/0123456789abcdef01234567";

describe("the picture a draw asks for", () => {
  it("asks the display server for a small copy at a list's sizes, the picture as it is past them", () => {
    // a page's row (52 CSS px) and a card (up to 240)
    expect(artSrc(own, 52)).toBe(`${own}?size=thumb`);
    expect(artSrc(own, 160)).toBe(`${own}?size=thumb`);
    expect(artSrc(own, 240)).toBe(`${own}?size=card`);
    // the cover, drawn large
    expect(artSrc(own, 241)).toBe(own);
    expect(artSrc(own, 1200)).toBe(own);
  });

  it("draws every other server's picture through the window's thumbnail cache at the same tiers", () => {
    const url = "http://192.168.1.5:9000/art/1.jpg";
    const u = encodeURIComponent(url);
    expect(artSrc(url, 52)).toBe(`tt-art://thumb/thumb/${u}?u=${u}`);
    expect(artSrc(url, 240, "k")).toBe(`tt-art://thumb/card/k?u=${u}`);
    expect(artSrc(url, 241)).toBe(url);
  });

  it("passes what is already local, and nothing for no picture", () => {
    expect(artSrc("data:image/png;base64,AA", 52)).toBe("data:image/png;base64,AA");
    expect(artSrc("tt-art://picked/a.jpg", 52)).toBe("tt-art://picked/a.jpg");
    expect(artSrc(null, 52)).toBeNull();
  });
});
