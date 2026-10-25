import { beforeAll, describe, expect, it } from "vitest";
import { describeProfileNote, type MediaIndexPools } from "@shared/model";
import { startFakeStreamer, type FakeStreamerOptions } from "./__fixtures__/fakeStreamer";
import { pools, rebuild } from "./mediaIndex";
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
