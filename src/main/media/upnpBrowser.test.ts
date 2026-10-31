import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeStreamer, type FakeStreamer } from "./__fixtures__/fakeStreamer";
import { LARGE_QUEUE_TRACKS } from "@shared/model";
import {
  LargeQueueError,
  ObjectGoneError,
  presetSave,
  probeObject,
  queueAdd,
  refreshServers,
  search,
  serversListed,
} from "./upnpBrowser";

describe("search: the live search on a server that answers 150 at a time", () => {
  let server: FakeStreamer;

  beforeAll(async () => {
    server = await startFakeStreamer({ searchPaged: true });
    await refreshServers(server.host);
  });

  afterAll(() => server.stop());

  it("pages through to the server's total", async () => {
    const before = server.searchCalls;
    const r = await search(server.host, "mock-udn-1", "mock");
    const asked = server.searchCalls - before;
    const artists = r.items.filter((n) => n.isContainer && /person|Artist/.test(n.upnpClass));
    expect(r.items.length).toBe(r.total);
    expect(artists.length).toBeGreaterThan(150);
    expect(asked).toBeGreaterThan(3);
  });
});

describe("serversListed: the server listing in flight, however long it takes", () => {
  it("waits with no cap of its own, and settles when the listing does", async () => {
    const server = await startFakeStreamer({ holdUpnp: true, artists: 4 });
    try {
      const listed = refreshServers(server.host);
      let settled = false;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const waited = serversListed().then(() => {
        settled = true;
      });
      // a minute on the clock: a cap of any length short of it would have answered by now
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      expect(settled).toBe(false);
      server.releaseUpnp();
      expect((await listed).map((s) => s.udn)).toEqual(["mock-udn-1"]);
      await waited;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
      await server.stop();
    }
  });
});

describe("a blank is not an object: Asset's answer for an id it no longer has", () => {
  it("reads a re-minted album as missing, and refuses to save the blank to a preset", async () => {
    const server = await startFakeStreamer({ assetIds: true, artists: 4 });
    try {
      await refreshServers(server.host);
      const found = await search(server.host, "mock-udn-1", "Amber Nights");
      const album = found.items.find((n) => n.isContainer && n.title === "Amber Nights");
      expect(album?.id).toMatch(/^g1~/);
      if (!album) return;
      expect(await probeObject(server.host, "mock-udn-1", album.id)).toBe("present");
      server.remint();
      // HTTP 200 and a container "-1" with an empty title: the id is gone
      expect(await probeObject(server.host, "mock-udn-1", album.id)).toBe("missing");
      await expect(presetSave(server.host, "mock-udn-1", album.id, 90)).rejects.toBeInstanceOf(
        ObjectGoneError,
      );
    } finally {
      await server.stop();
    }
  });
});

describe("queueAdd: the large-queue guard (S77's static pin, a unit since 0.13.0-rc.6)", () => {
  it("counts a container first and refuses one over LARGE_QUEUE_TRACKS unless confirmed", async () => {
    const server = await startFakeStreamer({ artists: LARGE_QUEUE_TRACKS + 1 });
    try {
      await refreshServers(server.host);
      const refused: unknown = await queueAdd(
        server.host,
        "mock-udn-1",
        "lib-artists",
        "REPLACE",
      ).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(LargeQueueError);
      expect(refused instanceof LargeQueueError ? refused.tracks : 0).toBeGreaterThan(
        LARGE_QUEUE_TRACKS,
      );
      expect(server.queueAdds).toBe(0);
      await queueAdd(server.host, "mock-udn-1", "lib-artists", "REPLACE", undefined, {
        confirmLarge: true,
      });
      expect(server.queueAdds).toBe(1);
    } finally {
      await server.stop();
    }
  });
});
