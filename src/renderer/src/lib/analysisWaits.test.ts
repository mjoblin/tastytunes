import { describe, expect, it } from "vitest";
import { waitForStored, waitingOn } from "./analysisWaits";

const song = { contentKey: "band|record|song|200", serverUdn: "display", objectId: "a1" };

describe("the files a page waits on for their stored analysis", () => {
  it("names a file once however many surfaces wait on it, and until the last stops", () => {
    const strip = waitForStored(song);
    const scene = waitForStored(song);
    expect(waitingOn(song.contentKey)).toEqual([{ serverUdn: "display", objectId: "a1" }]);
    strip();
    expect(waitingOn(song.contentKey)).toEqual([{ serverUdn: "display", objectId: "a1" }]);
    scene();
    expect(waitingOn(song.contentKey)).toEqual([]);
  });

  it("names only the files waiting on the key the app stored", () => {
    const stop = waitForStored(song);
    const other = waitForStored({ ...song, contentKey: "band|record|other|180", objectId: "b2" });
    expect(waitingOn("band|record|other|180")).toEqual([{ serverUdn: "display", objectId: "b2" }]);
    expect(waitingOn("someone|else|entirely|90")).toEqual([]);
    stop();
    other();
  });

  it("lets a surface stop waiting twice without stopping another's wait", () => {
    const one = waitForStored(song);
    const two = waitForStored(song);
    one();
    one();
    expect(waitingOn(song.contentKey)).toHaveLength(1);
    two();
  });
});
