import { describe, expect, it } from "vitest";
import { wikiThumbAt } from "./artUrl";

const THUMB =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Arctic_Monkeys_2023.jpg/320px-Arctic_Monkeys_2023.jpg";

describe("wikiThumbAt", () => {
  it("asks for the smallest standard width covering twice the size", () => {
    expect(wikiThumbAt(THUMB, 240)).toBe(THUMB.replace("/320px-", "/500px-"));
    expect(wikiThumbAt(THUMB, 400)).toBe(THUMB.replace("/320px-", "/960px-"));
  });

  it("stops at the largest standard width", () => {
    expect(wikiThumbAt(THUMB, 900)).toBe(THUMB.replace("/320px-", "/1280px-"));
  });

  it("answers null when the thumbnail is already wide enough", () => {
    expect(wikiThumbAt(THUMB, 160)).toBeNull();
    expect(wikiThumbAt(THUMB.replace("/320px-", "/960px-"), 400)).toBeNull();
  });

  it("keeps the wiki and a file name with dots and a second extension", () => {
    const svg =
      "https://upload.wikimedia.org/wikipedia/en/thumb/1/1a/Band.logo.svg/320px-Band.logo.svg.png";
    expect(wikiThumbAt(svg, 300)).toBe(svg.replace("/320px-", "/960px-"));
  });

  it("leaves every other URL alone", () => {
    expect(wikiThumbAt("http://192.168.1.10:9790/aa/12/cover.jpg", 400)).toBeNull();
    expect(
      wikiThumbAt("https://upload.wikimedia.org/wikipedia/commons/a/ab/Original.jpg", 400),
    ).toBeNull();
    expect(wikiThumbAt(null, 400)).toBeNull();
  });
});
