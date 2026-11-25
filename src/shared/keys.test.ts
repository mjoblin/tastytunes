import { describe, expect, it } from "vitest";
import {
  foldFields,
  matchesQuery,
  matchesWords,
  mediaType,
  nameKey,
  queryWords,
  searchFold,
} from "./keys";

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

describe("searchFold and the one text match", () => {
  it("folds accents, the letters that carry none, and punctuation", () => {
    expect(searchFold("Motörhead")).toBe("motorhead");
    expect(searchFold("RÜFÜS")).toBe("rufus");
    expect(searchFold("Sigur Rós")).toBe("sigur ros");
    expect(searchFold("Mø")).toBe("mo");
    expect(searchFold("Straße")).toBe("strasse");
    expect(searchFold("AC/DC")).toBe("acdc");
    expect(searchFold("Hip-Hop")).toBe("hiphop");
    expect(searchFold("Don't")).toBe("dont");
    expect(searchFold("Beyoncé")).toBe("beyonce");
  });

  it("finds a name however its accents and punctuation are typed", () => {
    expect(matchesQuery("motorhead", ["Motörhead"])).toBe(true);
    expect(matchesQuery("Motörhead", ["Motorhead"])).toBe(true);
    expect(matchesQuery("rufus", ["RÜFÜS DU SOL"])).toBe(true);
    expect(matchesQuery("acdc", ["AC/DC"])).toBe(true);
    expect(matchesQuery("ac/dc back", ["AC/DC", "Back in Black"])).toBe(true);
    expect(matchesQuery("hip hop", ["Hip-Hop"])).toBe(true);
    expect(matchesQuery("maiden beast", ["Iron Maiden", "The Number of the Beast"])).toBe(true);
    expect(matchesQuery("maiden piece", ["Iron Maiden", "The Number of the Beast"])).toBe(false);
  });

  it("keeps a word that is all punctuation as typed", () => {
    expect(queryWords("!!! strange")).toEqual([
      { typed: "!!!", folded: "" },
      { typed: "strange", folded: "strange" },
    ]);
    expect(matchesQuery("!!!", ["!!!", "Strange Weather, Isn't It?"])).toBe(true);
    expect(matchesQuery("!!!", ["Strange Weather"])).toBe(false);
  });

  it("matches everything on an empty query, as the filters always have", () => {
    expect(queryWords("   ")).toEqual([]);
    expect(matchesQuery("", ["anything"])).toBe(true);
  });
});

describe("a record folded once and searched many times", () => {
  it("answers as folding at every search does, the typed form included", () => {
    const fields = ["Ace of Spades", "Motörhead", null, "Kilmister"];
    const folded = foldFields(fields);
    for (const q of ["motorhead", "ace spades", "kilmister", "!!!", "beatles", "Motör"])
      expect(matchesWords(queryWords(q), fields, folded)).toBe(matchesQuery(q, fields));
  });
});
