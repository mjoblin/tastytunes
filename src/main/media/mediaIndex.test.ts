import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  describeProfileNote,
  type MediaIndexPools,
  type MediaNode,
  type MediaServerInfo,
} from "@shared/model";
import {
  startFakeStreamer,
  type FakeStreamer,
  type FakeStreamerOptions,
} from "./__fixtures__/fakeStreamer";
import { currentIdFor, ensureFresh, pools, rebuild, revalidate, sameNode } from "./mediaIndex";
import { refreshServers } from "./upnpBrowser";

describe("rebuild: the drive's folder albums", () => {
  // the streamer's USB server, built by a walk; each index is read off pools() when it is built
  const indexOf = async (opts: FakeStreamerOptions): Promise<MediaIndexPools | undefined> => {
    const drive = await startFakeStreamer({
      searchCaps: "",
      rotatingIds: true,
      artists: 3,
      ...opts,
    });
    try {
      const own = (await refreshServers(drive.host)).find((x) => x.udn === "mock-udn-1");
      if (!own) throw new Error("the fake streamer lists no server");
      await rebuild(drive.host, own);
      return pools().find((x) => x.udn === "mock-udn-1");
    } finally {
      await drive.stop();
    }
  };
  let usb: MediaIndexPools | undefined;
  let plain: MediaIndexPools | undefined;
  const of = (title: string): Array<string | null> | undefined =>
    usb?.albums.filter((a) => a.title === title).map((a) => a.artist);

  beforeAll(async () => {
    usb = await indexOf({ usbFolders: true });
    plain = await indexOf({});
  });

  it('gives the folder albums ("<artist> - <album>", no artist) their tracks\' artist and album name', () => {
    expect(usb?.albums.length ?? 0).toBeGreaterThan(40);
    expect(usb?.albums.every((a) => a.artist && !/ - /.test(a.title))).toBe(true);
    expect(of("Amber Nights")).toEqual(["The Mock Artists"]);
    expect(of("Godzone Mix")).toEqual(["Various Artists"]);
    expect(of("Dark Skies")).toHaveLength(2);
  });

  it("says so in the server's notes", () => {
    const note = usb?.profile?.notes.find((n) => n.kind === "albums-from-their-tracks");
    expect(note).toBeDefined();
    if (note?.kind !== "albums-from-their-tracks") return;
    expect(note.count).toBe(usb?.albums.length);
    expect(describeProfileNote(note)).toMatch(
      /listed without an artist took their artist and name from their tracks/,
    );
  });

  it("leaves a server that credits its albums untouched: no note, the same titles and artists", () => {
    expect(plain?.profile?.notes.some((n) => n.kind === "albums-from-their-tracks")).toBe(false);
    const named = (p: MediaIndexPools | undefined): Array<[string, string | null]> | undefined =>
      p?.albums.map((a): [string, string | null] => [a.title, a.artist]).sort();
    expect(named(plain)).toEqual(named(usb));
  });
});

describe("a library re-minted under an unmoved counter (Asset, 0.13.0-rc.6)", () => {
  let server: FakeStreamer;
  let servers: MediaServerInfo[];
  let listed: MediaServerInfo | undefined;
  const own = (): MediaIndexPools | undefined => pools().find((p) => p.udn === "mock-udn-1");
  const amber = (): MediaNode | undefined => own()?.albums.find((a) => a.title === "Amber Nights");

  beforeAll(async () => {
    server = await startFakeStreamer({ assetIds: true, artists: 4 });
    servers = await refreshServers(server.host);
    ensureFresh(server.host, servers);
    listed = servers.find((x) => x.udn === "mock-udn-1");
    if (listed) await rebuild(server.host, listed);
  });

  afterAll(() => server.stop());

  it("is rebuilt on the next listing, though its counter did not move", async () => {
    expect(amber()?.id).toMatch(/^g1~/);
    server.remint();
    ensureFresh(server.host, servers);
    await vi.waitFor(() => expect(amber()?.id).toMatch(/^g2~/), { timeout: 10_000 });
  });

  it("finds a gone album and a gone track under their current ids", async () => {
    const album = amber();
    const track = own()?.tracks.find((t) => t.album === "Amber Nights" && t.trackNumber === 2);
    expect(album && track).toBeTruthy();
    if (!album || !track) return;
    server.remint();
    // the album's own rebuild, then the track traced through the index it replaced
    const nowAlbum = await currentIdFor(server.host, "mock-udn-1", album.id);
    const nowTrack = await currentIdFor(server.host, "mock-udn-1", track.id);
    expect(nowAlbum).toBe(amber()?.id);
    expect(nowAlbum).toMatch(/^g3~/);
    expect(nowTrack).toMatch(/^g3~/);
    expect(own()?.tracks.find((t) => t.id === nowTrack)?.title).toBe(track.title);
    expect(await currentIdFor(server.host, "mock-udn-1", "g3~no-such-album")).toBeNull();
  });

  // S83's static pin, a unit since 0.13.0-rc.6 (the Browse-built half is resolveContent.test.ts's)
  it("revalidates a search-built index by the id in hand, two askers sharing one rebuild", async () => {
    if (!listed) throw new Error("the fake streamer lists no server");
    const before = server.searchCalls;
    await rebuild(server.host, listed);
    const oneWalk = server.searchCalls - before;
    const held = amber()?.id ?? "";
    expect(await revalidate(server.host, "mock-udn-1", held)).toBe(false);
    server.remint();
    const asked = server.searchCalls;
    const both = await Promise.all([
      revalidate(server.host, "mock-udn-1", held),
      revalidate(server.host, "mock-udn-1", held),
    ]);
    expect(both).toEqual([true, true]);
    expect(server.searchCalls - asked).toBe(oneWalk);
    expect(amber()?.id).not.toBe(held);
  });
});

describe("sameNode: the node in a rebuilt index", () => {
  const node = (over: Partial<MediaNode>): MediaNode => ({
    id: "x",
    parentId: "p",
    title: "Manning Fireworks",
    upnpClass: "object.container.album.musicAlbum",
    isContainer: true,
    artUrl: "http://asset/aa/364127631829389/cover.jpg",
    artist: "MJ Lenderman",
    album: null,
    year: "2024",
    trackNumber: null,
    durationSecs: null,
    ...over,
  });
  const was = node({ id: "co648974" });

  it("finds an album by its picture, then by its title and artist", () => {
    const now = node({ id: "coEDD6" });
    expect(
      sameNode({ albums: [now, node({ id: "o", title: "Other", artUrl: "a" })], tracks: [] }, was)
        ?.id,
    ).toBe("coEDD6");
    const repictured = node({ id: "coNEW", artUrl: "http://asset/aa/1/cover.jpg" });
    expect(sameNode({ albums: [repictured], tracks: [] }, was)?.id).toBe("coNEW");
  });

  it("answers null for no match or more than one", () => {
    expect(sameNode({ albums: [], tracks: [] }, was)).toBeNull();
    const twins = [node({ id: "a", artUrl: null }), node({ id: "b", artUrl: null })];
    expect(sameNode({ albums: twins, tracks: [] }, node({ artUrl: null }))).toBeNull();
  });

  it("finds a track by its title, album and number", () => {
    const t = (id: string, n: number): MediaNode =>
      node({
        id,
        isContainer: false,
        upnpClass: "object.item.audioItem.musicTrack",
        title: "Rudolph",
        album: "Manning Fireworks",
        trackNumber: n,
      });
    expect(sameNode({ albums: [], tracks: [t("new3", 3), t("new4", 4)] }, t("old3", 3))?.id).toBe(
      "new3",
    );
  });
});
