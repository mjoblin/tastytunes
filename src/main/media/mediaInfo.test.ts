import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MediaInfoQuery } from "@shared/model";
import { startFakeStreamer, type FakeStreamer } from "./__fixtures__/fakeStreamer";
import { lookupMediaInfo } from "./mediaInfo";
import { rebuild, status } from "./mediaIndex";
import { refreshServers } from "./upnpBrowser";

describe("lookupMediaInfo: a show and an act on the streamer's USB drive after its ids rotate", () => {
  // the streamer's own USB server: on its address, Browse-only, its ids re-minted by the mount
  let drive: FakeStreamer;
  let builtBefore: number | null = null;
  const builtAt = (): number | null =>
    status().find((s) => s.udn === "mock-udn-1")?.builtAt ?? null;
  const q: MediaInfoQuery = {
    kind: "track",
    title: "Mock Track 3",
    artist: "The Mock Artists",
    album: "Amber Nights",
  };

  beforeAll(async () => {
    drive = await startFakeStreamer({ searchCaps: "", rotatingIds: true, artists: 3 });
    const own = (await refreshServers(drive.host)).find((s) => s.udn === "mock-udn-1");
    if (!own) throw new Error("the fake streamer lists no server");
    await rebuild(drive.host, own);
    builtBefore = builtAt();
    drive.rotate();
  });

  afterAll(() => drive.stop());

  it("answers a show from the index as it stands, and starts no rebuild", async () => {
    const shown = await lookupMediaInfo(drive.host, q, "show");
    expect(shown?.node.id).toBe("26:alb-1-t3");
    expect(builtBefore).not.toBeNull();
    expect(builtAt()).toBe(builtBefore);
  });

  it("confirms an act, rebuilds and answers the new id", async () => {
    const acted = await lookupMediaInfo(drive.host, q, "act");
    expect(acted?.node.id).toBe("27:alb-1-t3");
    expect(builtAt()).not.toBe(builtBefore);
  });
});
