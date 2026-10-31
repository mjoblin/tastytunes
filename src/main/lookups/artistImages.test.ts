import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The chooser's Wikipedia images: one artist's lookup (MusicBrainz search, its links, the
// article's summary) then the article's media list, on a fake fetch shaped like Wikipedia's
// answers as they are now (2026-10-25: thumb.wikimedia.org, protocol-relative, with a query).
let fetchArtistImages: (artist: string) => Promise<string[]>;
let fetchArtistInfo: (artist: string, force?: boolean) => Promise<unknown>;
let asked: string[] = [];
let media: unknown = null;
let mediaStatus = 200;

const LEAD =
  "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5a/Band_live_(cropped).jpg/330px-Band_live_(cropped).jpg?utm_source=en.wikipedia.org&utm_campaign=api";
const item = (title: string, src: string, more: object = {}): object => ({
  type: "image",
  showInGallery: true,
  title,
  srcset: [
    { src, scale: "1x" },
    { src: src.replace("/500px-", "/750px-"), scale: "1.5x" },
  ],
  ...more,
});

// each artist its own article (the lookups cache on disk across the file's tests)
function answer(url: string): { status: number; body: unknown } {
  const search = /\/ws\/2\/artist\?query=artist:([^&]+)/.exec(url);
  if (search) {
    const name = (JSON.parse(decodeURIComponent(search[1])) as string).replace(/ /g, "_");
    return { status: 200, body: { artists: [{ id: `mbid-${name}`, name, score: 100 }] } };
  }
  const lookup = /\/ws\/2\/artist\/mbid-([^?]+)/.exec(url);
  if (lookup)
    return {
      status: 200,
      body: {
        relations: [
          {
            type: "wikipedia",
            url: { resource: `https://en.wikipedia.org/wiki/${lookup[1]}_(group)` },
          },
        ],
      },
    };
  const summary = /\/page\/summary\/(.+)$/.exec(url);
  if (summary)
    return {
      status: 200,
      body: {
        extract: "A band.",
        thumbnail: { source: LEAD },
        content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${summary[1]}` } },
      },
    };
  if (url.includes("/page/media-list/")) return { status: mediaStatus, body: media };
  return { status: 404, body: {} };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  asked = [];
  mediaStatus = 200;
  media = {
    items: [
      item(
        "File:Band_live_(cropped).jpg",
        "//thumb.wikimedia.org/wikipedia/commons/thumb/5/5a/Band_live_(cropped).jpg/500px-Band_live_(cropped).jpg?utm_source=en.wikipedia.org&utm_campaign=parser",
      ),
      item(
        "File:Band_1995.jpg",
        "//thumb.wikimedia.org/wikipedia/commons/thumb/0/05/Band_1995.jpg/500px-Band_1995.jpg?utm_campaign=parser",
      ),
      item(
        "File:Band_logo.svg",
        "//thumb.wikimedia.org/wikipedia/commons/thumb/1/1a/Band_logo.svg/500px-Band_logo.svg.png",
      ),
      item(
        "File:Hidden.jpg",
        "//thumb.wikimedia.org/wikipedia/commons/thumb/2/2b/Hidden.jpg/500px-Hidden.jpg",
        { showInGallery: false },
      ),
      { type: "video", title: "File:Clip.webm", srcset: [{ src: "//x/clip.jpg", scale: "1x" }] },
      { type: "image", showInGallery: false },
    ],
  };
  vi.stubGlobal("fetch", (url: string | URL) => {
    asked.push(String(url));
    const { status, body } = answer(String(url));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  vi.resetModules();
  ({ fetchArtistImages, fetchArtistInfo } = await import("./artistInfo"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function images(artist: string): Promise<string[]> {
  const got = fetchArtistImages(artist);
  await vi.runAllTimersAsync();
  return got;
}

describe("the article's images", () => {
  it("are the lead picture first, then the gallery's other photos, each once, as https", async () => {
    expect(await images("Band")).toEqual([
      LEAD,
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/05/Band_1995.jpg/500px-Band_1995.jpg?utm_campaign=parser",
    ]);
    expect(asked.some((u) => u.endsWith("/api/rest_v1/page/media-list/Band_(group)"))).toBe(true);
  });

  it("are asked for once per article", async () => {
    await images("Band Two");
    const lists = asked.filter((u) => u.includes("/media-list/")).length;
    expect(lists).toBe(1);
    await images("Band Two");
    expect(asked.filter((u) => u.includes("/media-list/")).length).toBe(lists);
  });

  it("are asked for again once the artist's details are refreshed", async () => {
    await images("Band Four");
    const lists = (): number => asked.filter((u) => u.includes("/media-list/Band_Four")).length;
    expect(lists()).toBe(1);
    const refreshed = fetchArtistInfo("Band Four", true);
    await vi.runAllTimersAsync();
    await refreshed;
    await images("Band Four");
    expect(lists()).toBe(2);
    await images("Band Four");
    expect(lists()).toBe(2);
  });

  it("fall back to the lead picture alone when the list cannot be had, and ask again later", async () => {
    mediaStatus = 503;
    expect(await images("Band Three")).toEqual([LEAD]);
    mediaStatus = 200;
    expect((await images("Band Three")).length).toBe(2);
  });
});
