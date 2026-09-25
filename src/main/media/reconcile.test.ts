/**
 * The POOL rules: what can only be decided over a whole crawl result.
 *
 * Every rule here must be a no-op on a spec-clean server, and each describe
 * block below shows the shape that taught it (the server named in
 * reconcile.ts) beside the clean shape it must leave alone. Nodes are built
 * directly, as didl.ts would hand them over.
 */
import { describe, expect, it } from "vitest";
import type { MediaNode } from "@shared/model";
import {
  albumsFromTracks,
  audioItemsOnly,
  dedupeAlbums,
  emptyProfile,
  preferCopy,
  richer,
  settleClasses,
  stripParentArtist,
  yearFromTracks,
} from "./reconcile";

const BASE = "object.container.album";
const LEAF = "object.container.album.musicAlbum";

type Fields = Partial<MediaNode> & Pick<MediaNode, "id" | "title">;

const node = (f: Fields): MediaNode => ({
  parentId: null,
  upnpClass: "",
  isContainer: false,
  artUrl: null,
  artist: null,
  album: null,
  year: null,
  trackNumber: null,
  durationSecs: null,
  ...f,
});

const album = (id: string, title: string, f: Partial<MediaNode> = {}): MediaNode =>
  node({ id, title, isContainer: true, upnpClass: LEAF, ...f });

const track = (id: string, title: string, f: Partial<MediaNode> = {}): MediaNode =>
  node({ id, title, upnpClass: "object.item.audioItem.musicTrack", ...f });

describe("POOL RULE class-settling", () => {
  it("a server that generalizes every result to the base class (Asset): all promoted", () => {
    const pool = [album("a1", "One", { upnpClass: BASE }), album("a2", "Two", { upnpClass: BASE })];
    const settled = settleClasses(pool, BASE, LEAF);
    expect(settled.mode).toBe("generalized");
    expect(settled.dropped).toBe(0);
    expect(settled.kept.map((n) => n.upnpClass)).toEqual([LEAF, LEAF]);
  });

  it("a server that distinguishes the leaf (minidlna): the bare entries are navigation, dropped", () => {
    const pool = [
      album("a1", "One"),
      album("all", "- All Albums -", { upnpClass: BASE }),
      album("a2", "Two"),
    ];
    const settled = settleClasses(pool, BASE, LEAF);
    expect(settled.mode).toBe("leaf");
    expect(settled.kept.map((n) => n.id)).toEqual(["a1", "a2"]);
    expect(settled.dropped).toBe(1);
  });

  it("a server whose answer is not album-derived at all (Emby, UMS): nothing is an album", () => {
    const pool = [
      node({
        id: "f1",
        title: "Music",
        isContainer: true,
        upnpClass: "object.container.storageFolder",
      }),
      node({
        id: "f2",
        title: "Rips",
        isContainer: true,
        upnpClass: "object.container.storageFolder",
      }),
    ];
    expect(settleClasses(pool, BASE, LEAF)).toEqual({ kept: [], mode: "unhonoured", dropped: 2 });
  });

  it("a server that answers with everything (Jellyfin): the leaf albums, and only those", () => {
    const pool = [
      album("a1", "One"),
      track("t1", "A track"),
      node({
        id: "f1",
        title: "Folder",
        isContainer: true,
        upnpClass: "object.container.storageFolder",
      }),
      album("a2", "Two"),
    ];
    const settled = settleClasses(pool, BASE, LEAF);
    expect(settled.mode).toBe("leaf");
    expect(settled.kept.map((n) => n.id)).toEqual(["a1", "a2"]);
    expect(settled.dropped).toBe(2);
  });

  it("an empty answer is empty", () => {
    expect(settleClasses([], BASE, LEAF)).toEqual({ kept: [], mode: "empty", dropped: 0 });
  });
});

describe("POOL RULE audio-items-only", () => {
  it("keeps audio items and drops containers and other items (Jellyfin)", () => {
    const pool = [
      track("t1", "Song"),
      album("a1", "Album"),
      node({ id: "v1", title: "Clip", upnpClass: "object.item.videoItem" }),
      track("t2", "Another"),
    ];
    const { kept, dropped } = audioItemsOnly(pool);
    expect(kept.map((n) => n.id)).toEqual(["t1", "t2"]);
    expect(dropped).toBe(2);
  });
});

describe("POOL RULE year-from-tracks (minidlna)", () => {
  it("an undated album takes the year most of its tracks agree on", () => {
    const albums = [album("a1", "Undated")];
    const tracks = [
      track("t1", "One", { album: "undated", year: "2004" }),
      track("t2", "Two", { album: "Undated", year: "2005" }),
      track("t3", "Three", { album: "Undated", year: "2005" }),
    ];
    const { albums: out, filled } = yearFromTracks(albums, tracks);
    expect(out[0].year).toBe("2005");
    expect(filled).toBe(1);
  });

  it("is a no-op for a dated album, and for an album whose tracks carry no year", () => {
    const dated = album("a1", "Dated", { year: "1999" });
    const bare = album("a2", "Bare");
    const tracks = [
      track("t1", "One", { album: "Dated", year: "2004" }),
      track("t2", "Two", { album: "Bare" }),
    ];
    const { albums: out, filled } = yearFromTracks([dated, bare], tracks);
    expect(out[0]).toBe(dated);
    expect(out[1]).toBe(bare);
    expect(filled).toBe(0);
  });
});

describe("POOL RULE duplicate-containers (Gerbera)", () => {
  // one compilation, mirrored under Albums and under each performer's branch,
  // each mirror credited to the branch it sits in
  const mirrors = [
    album("m1", "Summer Mix", { parentId: "albums", year: "2010", artist: "Singer A" }),
    album("m2", "Summer Mix", {
      parentId: "artists/b",
      year: "2010",
      artist: "Singer B",
      artUrl: "http://server/art/m2.jpg",
    }),
    album("m3", "Summer Mix", { parentId: "artists/c", year: "2010", artist: "Singer C" }),
  ];
  const songs = [
    track("t1", "First", { album: "Summer Mix", artist: "Singer A", durationSecs: 200 }),
    track("t2", "Second", { album: "Summer Mix", artist: "Singer B", durationSecs: 210 }),
    track("t3", "Third", { album: "Summer Mix", artist: "Singer C", durationSecs: 220 }),
  ];

  it("scattered copies with no duplicated content collapse to one, the copy with art kept", () => {
    const { albums, collapsed } = dedupeAlbums(mirrors, songs);
    expect(albums).toHaveLength(1);
    expect(albums[0].id).toBe("m2");
    expect(collapsed).toBe(2);
  });

  it("credited to the album artist the tracks agree on", () => {
    const tagged = songs.map((t) => ({ ...t, albumArtist: "Various Artists" }));
    const [kept] = dedupeAlbums(mirrors, tagged).albums;
    expect(kept).toMatchObject({ artist: "Various Artists", albumArtist: "Various Artists" });
  });

  it("with no album artist, three or more different performers make Various Artists", () => {
    const [kept] = dedupeAlbums(mirrors, songs).albums;
    expect(kept.artist).toBe("Various Artists");
    expect(kept).not.toHaveProperty("albumArtist");
  });

  it("copies that all name one artist keep that artist", () => {
    const same = mirrors.map((a) => ({ ...a, artist: "One Band" }));
    const [kept] = dedupeAlbums(same, songs).albums;
    expect(kept.artist).toBe("One Band");
  });

  it("twin editions survive: the pool holds the same content twice", () => {
    // a 16-bit rip and a 24-bit download of one album: same title and
    // duration under two ids
    const editions = [
      album("e1", "Record", { parentId: "p1", year: "2015", artist: "Band" }),
      album("e2", "Record", { parentId: "p2", year: "2015", artist: "Band" }),
    ];
    const tracks = [
      track("t1", "Song", { album: "Record", artist: "Band", durationSecs: 180 }),
      track("t2", "Song", { album: "Record", artist: "Band", durationSecs: 180 }),
    ];
    const { albums, collapsed } = dedupeAlbums(editions, tracks);
    expect(albums.map((a) => a.id)).toEqual(["e1", "e2"]);
    expect(collapsed).toBe(0);
  });

  it("siblings survive: two copies listed under one parent are distinct albums", () => {
    const boxed = [
      album("d1", "Box", { parentId: "shelf", artist: "Band" }),
      album("d2", "Box", { parentId: "shelf", artist: "Band" }),
    ];
    const tracks = [track("t1", "Only", { album: "Box", artist: "Band" })];
    expect(dedupeAlbums(boxed, tracks).albums).toHaveLength(2);
  });

  it("a browse crawl's every-parent-seen map counts toward siblings", () => {
    const copies = [
      album("c1", "Seen Twice", { parentId: "albums", artist: "Band" }),
      album("c2", "Seen Twice", { parentId: "artists/band", artist: "Band" }),
    ];
    const tracks = [track("t1", "Only", { album: "Seen Twice", artist: "Band" })];
    // on their own parents these collapse ...
    expect(dedupeAlbums(copies, tracks).albums).toHaveLength(1);
    // ... but c2 was also met under "albums", beside c1
    const parentsOf = new Map([["c2", new Set(["artists/band", "albums"])]]);
    expect(dedupeAlbums(copies, tracks, parentsOf).albums).toHaveLength(2);
  });

  it("with no tracks in the pool there is no evidence, and the group stands", () => {
    expect(dedupeAlbums(mirrors, []).albums).toHaveLength(3);
  });

  it("same-titled albums by two artists, each with its own tracks, are not copies", () => {
    const two = [
      album("x1", "Greatest Hits", { parentId: "artists/a", artist: "Band A" }),
      album("x2", "Greatest Hits", { parentId: "artists/b", artist: "Band B" }),
    ];
    const tracks = [
      track("t1", "Hit One", { album: "Greatest Hits", artist: "Band A" }),
      track("t2", "Hit Two", { album: "Greatest Hits", artist: "Band B" }),
    ];
    expect(dedupeAlbums(two, tracks).albums.map((a) => a.id)).toEqual(["x1", "x2"]);
  });

  it("is a no-op on albums that differ by title or year", () => {
    const albums = [
      album("a1", "Record", { year: "2001", parentId: "p1" }),
      album("a2", "Record", { year: "2002", parentId: "p2" }),
      album("a3", "Other", { year: "2001", parentId: "p3" }),
    ];
    const { albums: out, collapsed } = dedupeAlbums(albums, songs);
    expect(out).toEqual(albums);
    expect(collapsed).toBe(0);
  });
});

describe("POOL RULE richer-copy and canonical-branch (Plex)", () => {
  const thin = album("p1", "Record", { artist: "By Album" });
  const rich = album("p1", "Record", {
    artist: "Band",
    year: "2003",
    artUrl: "http://server/art/p1.jpg",
    genre: ["Rock"],
  });

  it("richer keeps the copy that knows more, the first on a tie", () => {
    expect(richer(thin, rich)).toBe(rich);
    expect(richer(rich, thin)).toBe(rich);
    const twin = { ...thin };
    expect(richer(thin, twin)).toBe(thin);
  });

  it("preferCopy: the copy under an artist container wins over mere richness", () => {
    const underArtist = { node: thin, underArtist: true };
    const listing = { node: rich, underArtist: false };
    expect(preferCopy(underArtist, listing)).toBe(underArtist);
    expect(preferCopy(listing, underArtist)).toBe(underArtist);
    // on equal footing, richness decides; the first copy seen stands alone
    expect(preferCopy({ node: thin, underArtist: false }, listing)).toBe(listing);
    expect(preferCopy(undefined, listing)).toBe(listing);
  });
});

describe("POOL RULE parent-as-artist (Plex)", () => {
  it("an album credited to the container it was listed in is not credited at all", () => {
    const listed = album("p1", "Record", { artist: "By Album", artists: ["By Album"] });
    const stripped = stripParentArtist(listed, "by album");
    expect(stripped.artist).toBeNull();
    expect(stripped).not.toHaveProperty("artists");
  });

  it("nor is one credited to a bare year or decade", () => {
    expect(stripParentArtist(album("p1", "R", { artist: "2000" }), null).artist).toBeNull();
    expect(stripParentArtist(album("p1", "R", { artist: "1990s" }), null).artist).toBeNull();
  });

  it("is a no-op on a real credit, and on tracks", () => {
    const real = album("p1", "R", { artist: "Band" });
    expect(stripParentArtist(real, "By Album")).toBe(real);
    // a band whose name is a year-and-more is not a year
    const named = album("p2", "R", { artist: "1975 Band" });
    expect(stripParentArtist(named, null)).toBe(named);
    const song = track("t1", "Song", { artist: "By Album" });
    expect(stripParentArtist(song, "By Album")).toBe(song);
  });
});

describe("POOL RULE albums-from-tracks (UMS, folder-only servers)", () => {
  it("builds one album per folder and album tag, with the folder as its id", () => {
    const tracks = [
      track("t1", "One", {
        parentId: "folder/1",
        album: "Record",
        artist: "Band",
        year: "2001",
        genre: ["Rock"],
      }),
      track("t2", "Two", {
        parentId: "folder/1",
        album: "Record",
        artist: "Band",
        year: "2001",
        artUrl: "http://server/art/1.jpg",
        genre: ["Indie"],
      }),
    ];
    expect(albumsFromTracks(tracks)).toEqual([
      {
        id: "folder/1",
        parentId: null,
        title: "Record",
        upnpClass: LEAF,
        isContainer: true,
        artUrl: "http://server/art/1.jpg",
        artist: "Band",
        album: null,
        year: "2001",
        trackNumber: null,
        durationSecs: null,
        genre: ["Rock", "Indie"],
      },
    ]);
  });

  it("is credited to the album artist every track agrees on", () => {
    const tracks = [
      track("t1", "One", { parentId: "f", album: "Mix", artist: "A", albumArtist: "Curator" }),
      track("t2", "Two", { parentId: "f", album: "Mix", artist: "B", albumArtist: "curator" }),
    ];
    const [built] = albumsFromTracks(tracks);
    expect(built).toMatchObject({ artist: "Curator", albumArtist: "Curator" });
  });

  it("else to the one performer every track shares, else to Various Artists", () => {
    const featuring = [
      track("t1", "One", { parentId: "f1", album: "Solo", artist: "Lead" }),
      track("t2", "Two", {
        parentId: "f1",
        album: "Solo",
        artist: "Lead; Guest",
        artists: ["Lead", "Guest"],
      }),
    ];
    expect(albumsFromTracks(featuring)[0].artist).toBe("Lead");
    const mixed = [
      track("t1", "One", { parentId: "f2", album: "Mix", artist: "A" }),
      track("t2", "Two", { parentId: "f2", album: "Mix", artist: "B" }),
    ];
    expect(albumsFromTracks(mixed)[0].artist).toBe("Various Artists");
  });

  it("keeps two same-titled albums in different folders apart, and skips untagged tracks", () => {
    const tracks = [
      track("t1", "One", { parentId: "f1", album: "Greatest Hits", artist: "A" }),
      track("t2", "Two", { parentId: "f2", album: "Greatest Hits", artist: "B" }),
      track("t3", "Loose", { parentId: "f3" }),
      track("t4", "Orphan", { album: "No Folder" }),
    ];
    expect(albumsFromTracks(tracks).map((a) => [a.id, a.artist])).toEqual([
      ["f1", "A"],
      ["f2", "B"],
    ]);
  });
});

describe("emptyProfile", () => {
  it("starts honest: what the strategy implies, and no notes", () => {
    expect(emptyProfile("search")).toEqual({
      strategy: "search",
      albumsFrom: "search",
      classSearch: "leaf",
      notes: [],
    });
    expect(emptyProfile("browse")).toEqual({
      strategy: "browse",
      albumsFrom: "browse",
      classSearch: "unavailable",
      notes: [],
    });
  });
});
