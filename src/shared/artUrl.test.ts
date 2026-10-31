import { describe, expect, it } from "vitest";
import { artKeyOf, isDeviceArt, thumbKey, wikiThumbAt } from "./artUrl";

const THUMB =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Arctic_Monkeys_2023.jpg/320px-Arctic_Monkeys_2023.jpg";

describe("wikiThumbAt", () => {
  it("asks for the smallest standard width covering twice the size", () => {
    expect(wikiThumbAt(THUMB, 240)).toBe(THUMB.replace("/320px-", "/500px-"));
    expect(wikiThumbAt(THUMB, 400)).toBe(THUMB.replace("/320px-", "/960px-"));
  });

  it("reads the thumbnails Wikipedia hands out now, on thumb.wikimedia.org with a query", () => {
    const now =
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5a/Band_(cropped).jpg/330px-Band_(cropped).jpg?utm_source=en.wikipedia.org&utm_campaign=api";
    expect(wikiThumbAt(now, 400)).toBe(now.replace("/330px-", "/960px-"));
    expect(wikiThumbAt(now, 160)).toBeNull();
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

describe("thumbKey", () => {
  // two editions of one album on a MinimServer: one content key, two pictures
  const edition = (id: string) => ({
    serverUdn: "minim",
    title: "Toto IV",
    album: null,
    artist: "Toto",
    isContainer: true,
    id,
  });
  const a = "http://10.0.1.154:9790/minimserver/*/Toto/Toto*20IV*20(1982)/cover.jpg";
  const b = "http://10.0.1.154:9790/minimserver/*/Toto/Toto*20IV*20(1999*20MFSL)/cover.jpg";

  it("keeps two same-titled editions apart on a server whose URLs are the pictures' own", () => {
    expect(artKeyOf(edition("1"))).toBe(artKeyOf(edition("2")));
    expect(thumbKey(artKeyOf(edition("1")), a, false)).not.toBe(
      thumbKey(artKeyOf(edition("2")), b, false),
    );
  });

  it("keeps two same-named disc folders of one artist apart there too", () => {
    const disc = { ...edition("d"), title: ">> Disc 1", artist: "Pink Floyd" };
    expect(thumbKey(artKeyOf(disc), `${a}?d1`, false)).not.toBe(
      thumbKey(artKeyOf(disc), `${b}?d1`, false),
    );
  });

  it("keys the streamer's own pictures by content alone, so a rotated id finds the same file", () => {
    const key = artKeyOf(edition("1"));
    expect(thumbKey(key, "http://192.168.50.45:8050/art/26:3:1", true)).toBe(key);
    expect(thumbKey(key, "http://192.168.50.45:8050/art/27:3:1", true)).toBe(key);
  });
});

describe("isDeviceArt", () => {
  it("is the streamer's host whatever the port", () => {
    expect(isDeviceArt("http://192.168.50.45:8050/art/1", "192.168.50.45")).toBe(true);
    expect(isDeviceArt("http://127.0.0.1:8124/art/p1.svg", "127.0.0.1:8123")).toBe(true);
  });

  it("is no other host, and nothing without a streamer or a URL", () => {
    expect(isDeviceArt("http://10.0.1.154:9790/minimserver/x.jpg", "192.168.50.45")).toBe(false);
    expect(isDeviceArt("http://localhost:8124/art/p1.svg", "127.0.0.1:8123")).toBe(false);
    expect(isDeviceArt("http://10.0.1.154/x.jpg", null)).toBe(false);
    expect(isDeviceArt("not a url", "192.168.50.45")).toBe(false);
  });
});
