import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PictureOffer } from "@shared/model";

// The chooser's Commons photos (0.14.0): the artist's lookup (MusicBrainz, its Wikipedia link),
// the article's Wikidata item, its Commons category, then the category's files with their sizes,
// on a fake fetch shaped like the real answers (2026-10-29, a-ha's: Category:A-ha, 36 files).
let fetchCommonsPhotos: (artist: string) => Promise<PictureOffer[]>;
let fetchWikimediaSizes: typeof import("./commons").fetchWikimediaSizes;
let wikimediaFile: (url: string) => string;
let asked: string[] = [];
let category: string | null = "Band";

const thumb = (dir: string, file: string): string =>
  `https://upload.wikimedia.org/wikipedia/commons/thumb/${dir}/${file}/330px-${file}`;
const info = (title: string, mime: string, width: number, height: number, dir = "a/ab"): object => {
  const file = title.replace(/^File:/, "").replace(/ /g, "_");
  return {
    title,
    imageinfo: [
      {
        url: `https://upload.wikimedia.org/wikipedia/commons/${dir}/${file}`,
        width,
        height,
        mime,
        thumburl: thumb(dir, file),
        descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
      },
    ],
  };
};

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
          { type: "wikipedia", url: { resource: `https://en.wikipedia.org/wiki/${lookup[1]}` } },
        ],
      },
    };
  const summary = /\/page\/summary\/(.+)$/.exec(url);
  if (summary)
    return {
      status: 200,
      body: {
        extract: "A band.",
        content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${summary[1]}` } },
      },
    };
  if (url.includes("prop=pageprops"))
    return {
      status: 200,
      body: { query: { pages: { "1": { pageprops: { wikibase_item: "Q42" } } } } },
    };
  if (url.includes("/Special:EntityData/Q42.json"))
    return {
      status: 200,
      body: {
        entities: {
          Q42: {
            claims: category ? { P373: [{ mainsnak: { datavalue: { value: category } } }] } : {},
          },
        },
      },
    };
  if (url.includes("generator=categorymembers"))
    return {
      status: 200,
      body: {
        query: {
          pages: {
            "3": info("File:Band 1985.jpg", "image/jpeg", 5795, 4764),
            "1": info("File:Band 1984.png", "image/png", 900, 600),
            "2": info("File:Band logo.svg", "image/svg+xml", 1000, 1000),
            "4": info("File:Band badge.jpg", "image/jpeg", 120, 90),
            "5": info("File:Band live.ogv", "video/ogg", 1920, 1080),
          },
        },
      },
    };
  if (url.includes("prop=imageinfo"))
    return {
      status: 200,
      body: {
        query: {
          pages: {
            "9": info("File:Band 1995.jpg", "image/jpeg", 2400, 1600),
          },
        },
      },
    };
  return { status: 404, body: {} };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  asked = [];
  category = "Band";
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
  ({ fetchCommonsPhotos, fetchWikimediaSizes, wikimediaFile } = await import("./commons"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function photos(artist: string): Promise<PictureOffer[]> {
  const got = fetchCommonsPhotos(artist);
  await vi.runAllTimersAsync();
  return got;
}

describe("the Commons category's photos", () => {
  it("are its photos only, each with its full size, the large ones offered at 1280", async () => {
    const got = await photos("Band");
    expect(got.map((o) => [wikimediaFile(o.url), o.width, o.height])).toEqual([
      ["Band 1984.png", 900, 600],
      ["Band 1985.jpg", 5795, 4764],
    ]);
    // a photo wider than 1280 is chosen at 1280, its tile at 330; a smaller one as it is
    expect(got[1].url).toMatch(/\/1280px-Band_1985\.jpg$/);
    expect(got[1].thumb).toMatch(/\/330px-Band_1985\.jpg$/);
    expect(got[0].url).toBe("https://upload.wikimedia.org/wikipedia/commons/a/ab/Band_1984.png");
    expect(got[1].page).toBe("https://commons.wikimedia.org/wiki/File%3ABand%201985.jpg");
    expect(asked.some((u) => u.includes("gcmtitle=Category%3ABand"))).toBe(true);
  });

  it("are asked for once per artist, and none is a settled answer", async () => {
    await photos("Band Two");
    const lists = (): number => asked.filter((u) => u.includes("categorymembers")).length;
    expect(lists()).toBe(1);
    await photos("Band Two");
    expect(lists()).toBe(1);
    category = null;
    expect(await photos("Band Three")).toEqual([]);
    expect(asked.filter((u) => u.includes("categorymembers")).length).toBe(1);
  });
});

describe("a Wikimedia file", () => {
  it("is named the same from its thumbnail and its original, as the API titles it", () => {
    expect(
      wikimediaFile(
        "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/75/A-ha_1984_%28CROPPED%29.jpg/330px-A-ha_1984_%28CROPPED%29.jpg?utm_source=x",
      ),
    ).toBe("A-ha 1984 (CROPPED).jpg");
    expect(wikimediaFile("https://upload.wikimedia.org/wikipedia/commons/7/75/A-ha_1984.jpg")).toBe(
      "A-ha 1984.jpg",
    );
    expect(wikimediaFile("https://x/thumb/1/1a/Logo.svg/500px-Logo.svg.png")).toBe("Logo.svg");
  });

  it("is sized by the API, fifty at a time, a file it leaves out unsized", async () => {
    const got = fetchWikimediaSizes([
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/05/Band_1995.jpg/500px-Band_1995.jpg",
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/06/Unknown.jpg/500px-Unknown.jpg",
    ]);
    await vi.runAllTimersAsync();
    const sizes = await got;
    expect(sizes.get("Band 1995.jpg")).toEqual({
      width: 2400,
      height: 1600,
      page: "https://commons.wikimedia.org/wiki/File%3ABand%201995.jpg",
    });
    expect(sizes.has("Unknown.jpg")).toBe(false);
  });
});
