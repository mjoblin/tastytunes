import { describe, expect, it } from "vitest";
import { mediaType, nameKey } from "./keys";

describe("nameKey", () => {
  it("finds a name the same however it is cased, padded or composed", () => {
    const composed = "Beyoncé";
    const decomposed = "Beyoncé";
    expect(composed).not.toBe(decomposed);
    expect(nameKey(decomposed)).toBe(nameKey(composed));
    expect(nameKey("  BEYONCÉ ")).toBe("beyoncé");
    expect(nameKey("Sigur Rós")).toBe(nameKey("sigur rós"));
  });

  it("composes what lowercasing decomposes", () => {
    expect(nameKey("İstanbul")).toBe("i̇stanbul".normalize("NFC"));
    expect(nameKey("İstanbul")).toBe(nameKey(nameKey("İstanbul")));
  });

  it("gives a key kept before 0.15.0 the same answer as its name", () => {
    for (const name of ["Björk", "Björk ", "  Mötley Crüe", "Sigur Rós", "İzel"]) {
      const kept = name.trim().toLowerCase();
      expect(nameKey(kept)).toBe(nameKey(name));
    }
  });

  it("takes nothing as the empty key", () => {
    expect(nameKey(null)).toBe("");
    expect(nameKey(undefined)).toBe("");
    expect(nameKey("   ")).toBe("");
  });
});

describe("mediaType", () => {
  it("is a Content-Type's own part, lowercased", () => {
    expect(mediaType("Image/JPEG; charset=binary")).toBe("image/jpeg");
    expect(mediaType(" application/json ")).toBe("application/json");
    expect(mediaType(null)).toBe("");
  });
});
