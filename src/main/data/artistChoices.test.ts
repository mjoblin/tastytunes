import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaIndexPools, MediaNode } from "@shared/model";
import {
  choiceOf,
  copyKept,
  isArtistChoice,
  keepAsItCame,
  pickedPath,
  pickedUrl,
  resolveChoice,
  setChoice,
  setCopy,
} from "./artistChoices";

const dir = (): string => join(app.getPath("userData"), "artist-pictures");
const FILE = "0123456789abcdef01234567.jpg";

const album = (id: string, title: string, artUrl: string | null): MediaNode => ({
  id,
  parentId: "music",
  title,
  upnpClass: "object.container.album.musicAlbum",
  isContainer: true,
  artUrl,
  artist: "Band",
  album: null,
  year: null,
  trackNumber: null,
  durationSecs: null,
  serverUdn: "uuid:nas",
});
const pools = (albums: MediaNode[], udn = "uuid:nas"): MediaIndexPools[] => [
  { udn, serverName: "NAS", albums, artists: [], tracks: [] },
];

beforeEach(() => {
  setChoice("Band", null);
  mkdirSync(dir(), { recursive: true });
});

/** The module as a launch reads it, from a choices file holding `text`: the sweep runs only once
 *  the file was read whole. */
async function readWhole(text: string): Promise<typeof import("./artistChoices")> {
  writeFileSync(join(app.getPath("userData"), "artist-choices.json"), text);
  vi.resetModules();
  return import("./artistChoices");
}

describe("what a chosen picture can be", () => {
  it("is an image, a cover with its album, or a file the app copied in", () => {
    expect(isArtistChoice({ kind: "image", url: "https://thumb.wikimedia.org/x.jpg" })).toBe(true);
    expect(isArtistChoice({ kind: "image", url: "file:///etc/passwd" })).toBe(false);
    expect(
      isArtistChoice({ kind: "cover", url: "http://nas/a.jpg", album: "Record", serverUdn: null }),
    ).toBe(true);
    expect(isArtistChoice({ kind: "cover", url: "http://nas/a.jpg", album: "" })).toBe(false);
    // a file only by a name the app made, and only once it is there
    expect(isArtistChoice({ kind: "file", file: FILE })).toBe(false);
    writeFileSync(join(dir(), FILE), "jpeg");
    expect(isArtistChoice({ kind: "file", file: FILE })).toBe(true);
    expect(isArtistChoice({ kind: "file", file: "../settings.json" })).toBe(false);
    expect(pickedPath("../../etc/passwd")).toBeNull();
    expect(isArtistChoice({ kind: "other", url: "https://x" })).toBe(false);
  });

  it("is kept by the artist's name in any case, with only its own fields", () => {
    setChoice("Band", {
      kind: "image",
      url: "https://thumb.wikimedia.org/x.jpg",
      extra: 1,
    } as never);
    const kept = choiceOf("band ") as Record<string, unknown> | null;
    expect(Object.keys(kept ?? {}).sort()).toEqual(["at", "kind", "url"]);
    expect(kept?.url).toBe("https://thumb.wikimedia.org/x.jpg");
    setChoice("BAND", null);
    expect(choiceOf("Band")).toBeNull();
  });
});

describe("the chosen picture as drawn", () => {
  it("is an image as chosen, and nothing with no choice", () => {
    expect(resolveChoice("Band", [])).toBeNull();
    setChoice("Band", { kind: "image", url: "https://thumb.wikimedia.org/x.jpg" });
    expect(resolveChoice("Band", [])).toEqual({
      kind: "image",
      url: "https://thumb.wikimedia.org/x.jpg",
      offered: "https://thumb.wikimedia.org/x.jpg",
    });
  });

  it("keeps a cover at its address while an album has it, the edition chosen of two", () => {
    setChoice("Band", {
      kind: "cover",
      url: "http://nas/jp.jpg",
      album: "Record",
      serverUdn: "uuid:nas",
    });
    const both = pools([
      album("us", "Record", "http://nas/us.jpg"),
      album("jp", "Record", "http://nas/jp.jpg"),
    ]);
    expect(resolveChoice("Band", both)?.url).toBe("http://nas/jp.jpg");
  });

  it("finds a cover again by its album when its address moved, on its own server only", () => {
    setChoice("Band", {
      kind: "cover",
      url: "http://evo/art/1",
      album: "Record",
      serverUdn: "uuid:usb",
    });
    // the drive re-minted its addresses
    expect(
      resolveChoice("Band", pools([album("a", "Record", "http://evo/art/9")], "uuid:usb"))?.url,
    ).toBe("http://evo/art/9");
    // another server's album of that title is not it: the address chosen stands
    expect(resolveChoice("Band", pools([album("a", "Record", "http://nas/r.jpg")]))?.url).toBe(
      "http://evo/art/1",
    );
  });

  it("draws a file from its copy, and nothing once the copy is gone", () => {
    writeFileSync(join(dir(), FILE), "jpeg");
    setChoice("Band", { kind: "file", file: FILE });
    expect(resolveChoice("Band", [])).toEqual({
      kind: "file",
      url: pickedUrl(FILE),
      offered: pickedUrl(FILE),
    });
    expect(pickedUrl(FILE)).toBe(`tt-art://picked/${FILE}`);
  });
});

describe("a chosen picture's copy (0.14.0)", () => {
  const COPY = "dddddddddddddddddddddddd.jpg";

  it("draws a picture or a cover from its copy, and keeps the address it was offered at", () => {
    writeFileSync(join(dir(), COPY), "jpeg");
    setChoice("Band", { kind: "image", url: "https://thumb.wikimedia.org/x.jpg" });
    const at = choiceOf("Band")?.at ?? 0;
    expect(copyKept(choiceOf("Band")!)).toBe(false);
    expect(setCopy("band", at, COPY)).toBe(true);
    expect(copyKept(choiceOf("Band")!)).toBe(true);
    expect(resolveChoice("Band", [])).toEqual({
      kind: "image",
      url: pickedUrl(COPY),
      offered: "https://thumb.wikimedia.org/x.jpg",
    });
    // a cover's offered address is its album's now, found again on its server
    setChoice("Band", {
      kind: "cover",
      url: "http://evo/art/1",
      album: "Record",
      serverUdn: "uuid:usb",
    });
    expect(setCopy("Band", choiceOf("Band")?.at ?? 0, COPY)).toBe(true);
    expect(
      resolveChoice("Band", pools([album("a", "Record", "http://evo/art/9")], "uuid:usb")),
    ).toEqual({ kind: "cover", url: pickedUrl(COPY), offered: "http://evo/art/9" });
  });

  it("is named only on the choice it was made for, and never on a file", () => {
    writeFileSync(join(dir(), COPY), "jpeg");
    setChoice("Band", { kind: "image", url: "https://thumb.wikimedia.org/x.jpg" });
    const at = choiceOf("Band")?.at ?? 0;
    // chosen again while the copy was made: the copy was for the choice before
    expect(setCopy("Band", at - 1, COPY)).toBe(false);
    expect(setCopy("Band", at, "../settings.json")).toBe(false);
    expect(choiceOf("Band")?.copy).toBeUndefined();
    writeFileSync(join(dir(), FILE), "jpeg");
    setChoice("Band", { kind: "file", file: FILE });
    expect(setCopy("Band", choiceOf("Band")?.at ?? 0, COPY)).toBe(false);
  });

  it("keeps a picture nativeImage can't read as it came, when the windows draw it", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="6" height="6"/>');
    const file = keepAsItCame(svg, "image/svg+xml");
    expect(file).toMatch(/^[0-9a-f]{24}\.svg$/);
    expect(pickedPath(file ?? "")).not.toBeNull();
    expect(keepAsItCame(Buffer.from("RIFF"), "image/webp")).toMatch(/\.webp$/);
    // not a picture the windows draw, or too large
    expect(keepAsItCame(Buffer.from("x"), "image/tiff")).toBeNull();
    expect(keepAsItCame(Buffer.alloc(3 * 1024 * 1024), "image/gif")).toBeNull();
  });

  it("goes back to the address once the copy is gone", () => {
    writeFileSync(join(dir(), COPY), "jpeg");
    setChoice("Band", { kind: "image", url: "https://thumb.wikimedia.org/x.jpg" });
    setCopy("Band", choiceOf("Band")?.at ?? 0, COPY);
    rmSync(join(dir(), COPY));
    expect(copyKept(choiceOf("Band")!)).toBe(false);
    expect(resolveChoice("Band", [])?.url).toBe("https://thumb.wikimedia.org/x.jpg");
  });

  it("is kept by the sweep while its choice names it, and goes an hour after a new choice", async () => {
    const { choiceOf, setChoice, setCopy } = await readWhole("{}");
    const old = "eeeeeeeeeeeeeeeeeeeeeeee.jpg";
    writeFileSync(join(dir(), old), "x");
    setChoice("Other", { kind: "image", url: "https://thumb.wikimedia.org/o.jpg" });
    setCopy("Other", choiceOf("Other")?.at ?? 0, old);
    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    utimesSync(join(dir(), old), twoHoursAgo, twoHoursAgo);
    setChoice("Band", null);
    expect(readdirSync(dir())).toContain(old);
    setChoice("Other", { kind: "image", url: "https://thumb.wikimedia.org/p.jpg" });
    expect(readdirSync(dir())).not.toContain(old);
    setChoice("Other", null);
  });
});

describe("the copied files", () => {
  it("go once no choice names them and they are over an hour old", async () => {
    const { setChoice } = await readWhole("{}");
    const old = "aaaaaaaaaaaaaaaaaaaaaaaa.jpg";
    const fresh = "bbbbbbbbbbbbbbbbbbbbbbbb.png";
    const kept = "cccccccccccccccccccccccc.jpg";
    for (const f of [old, fresh, kept]) writeFileSync(join(dir(), f), "x");
    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    utimesSync(join(dir(), old), twoHoursAgo, twoHoursAgo);
    utimesSync(join(dir(), kept), twoHoursAgo, twoHoursAgo);
    setChoice("Other", { kind: "file", file: kept });
    const left = readdirSync(dir());
    expect(left).toContain(fresh);
    expect(left).toContain(kept);
    expect(left).not.toContain(old);
    setChoice("Other", null);
  });

  it("stay when the choices file wasn't read whole, so a choice can't take the others with it", async () => {
    const orphan = "dddddddddddddddddddddddd.jpg";
    writeFileSync(join(dir(), orphan), "x");
    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    utimesSync(join(dir(), orphan), twoHoursAgo, twoHoursAgo);
    // a choice this version can't read, and a file that isn't JSON at all
    for (const text of [JSON.stringify({ someone: { kind: "later" } }), "{not json"]) {
      const { setChoice } = await readWhole(text);
      setChoice("Other", { kind: "image", url: "https://thumb.wikimedia.org/q.jpg" });
      expect(readdirSync(dir())).toContain(orphan);
      setChoice("Other", null);
    }
  });
});

describe("choices kept before 0.15.0's name key", () => {
  it("are found by a name written either way, the newer of two that become one", async () => {
    const img = (n: string): string => `https://thumb.wikimedia.org/${n}.jpg`;
    writeFileSync(
      join(app.getPath("userData"), "artist-choices.json"),
      JSON.stringify({
        "sigur ro\u0301s": { kind: "image", url: img("older"), at: 1 },
        "sigur rós": { kind: "image", url: img("newer"), at: 2 },
        "bjo\u0308rk": { kind: "image", url: img("bjork"), at: 3 },
      }),
    );
    vi.resetModules();
    const fresh = await import("./artistChoices");
    expect(fresh.choiceOf("Sigur Rós")).toMatchObject({ url: img("newer") });
    expect(fresh.choiceOf("Sigur Ro\u0301s")).toMatchObject({ url: img("newer") });
    expect(fresh.choiceOf("Björk")).toMatchObject({ url: img("bjork") });
    expect(fresh.choiceOf("Bjo\u0308rk")).toMatchObject({ url: img("bjork") });
  });
});

describe("a later version's choices, kept", () => {
  const img = (n: string): string => `https://thumb.wikimedia.org/${n}.jpg`;
  const written = (): Record<string, Record<string, unknown>> =>
    JSON.parse(
      readFileSync(join(app.getPath("userData"), "artist-choices.json"), "utf-8"),
    ) as Record<string, Record<string, unknown>>;

  it("writes back a field it doesn't read on a choice it does, and a choice of a later kind", async () => {
    const COPY = "ffffffffffffffffffffffff.jpg";
    writeFileSync(join(dir(), COPY), "jpeg");
    const later = { kind: "gallery", urls: [img("a"), img("b")], at: 4 };
    const fresh = await readWhole(
      JSON.stringify({
        band: {
          kind: "image",
          url: img("band"),
          at: 5,
          credit: "A. Photographer",
          crop: [0, 0, 1],
        },
        someone: later,
      }),
    );
    // read as this version reads it
    expect(fresh.choiceOf("Band")).toMatchObject({ kind: "image", url: img("band"), at: 5 });
    expect(fresh.resolveChoice("Band", [])?.url).toBe(img("band"));
    // a change through the normal path: another artist's choice, then Band's copy
    fresh.setChoice("Other", { kind: "image", url: img("other") });
    expect(fresh.setCopy("Band", 5, COPY)).toBe(true);
    const file = written();
    expect(file.band).toEqual({
      kind: "image",
      url: img("band"),
      at: 5,
      copy: COPY,
      credit: "A. Photographer",
      crop: [0, 0, 1],
    });
    expect(file.someone).toEqual(later);
    expect(file.other).toMatchObject({ kind: "image", url: img("other") });
    // read again, it is all still there
    vi.resetModules();
    const again = await import("./artistChoices");
    again.setChoice("Other", null);
    expect(written().band).toMatchObject({ credit: "A. Photographer", crop: [0, 0, 1] });
    expect(written().someone).toEqual(later);
    // a new choice made here replaces the old one whole
    again.setChoice("Band", { kind: "image", url: img("new") });
    expect(Object.keys(written().band).sort()).toEqual(["at", "kind", "url"]);
    again.setChoice("Band", null);
    rmSync(join(dir(), COPY), { force: true });
  });

  it("keeps the copied files while a choice holds a field it doesn't read", async () => {
    const orphan = "999999999999999999999999.jpg";
    writeFileSync(join(dir(), orphan), "x");
    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    utimesSync(join(dir(), orphan), twoHoursAgo, twoHoursAgo);
    // the later field may name a file where this version doesn't look
    const fresh = await readWhole(
      JSON.stringify({ band: { kind: "image", url: img("band"), at: 5, alt: orphan } }),
    );
    fresh.setChoice("Other", { kind: "image", url: img("other") });
    expect(readdirSync(dir())).toContain(orphan);
    fresh.setChoice("Other", null);
    fresh.setChoice("Band", null);
    rmSync(join(dir(), orphan), { force: true });
  });
});
