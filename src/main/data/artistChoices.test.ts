import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { beforeEach, describe, expect, it } from "vitest";
import type { MediaIndexPools, MediaNode } from "@shared/model";
import {
  choiceOf,
  isArtistChoice,
  pickedPath,
  pickedUrl,
  resolveChoice,
  setChoice,
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
    expect(resolveChoice("Band", [])).toEqual({ kind: "file", url: pickedUrl(FILE) });
    expect(pickedUrl(FILE)).toBe(`tt-art://picked/${FILE}`);
  });
});

describe("the copied files", () => {
  it("go once no choice names them and they are over an hour old", () => {
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
});
