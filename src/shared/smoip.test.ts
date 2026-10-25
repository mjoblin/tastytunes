import { describe, expect, it } from "vitest";
import { cdReleaseId, cdToc, trackTitle } from "./smoip";

const TOC = "Tracks: 10 Length: 37:39";
const ART =
  "http://coverartarchive.org/release/d53751bc-0595-4a60-8425-d9a19478fb55/33406720128.jpg";

describe("cdToc: a disc's table of contents", () => {
  it("parses the streamer's title for a stopped disc, an hour's disc too", () => {
    expect(cdToc(TOC)).toEqual({ tracks: 10, secs: 2259 });
    expect(cdToc("Tracks: 18 Length: 1:12:30")).toEqual({ tracks: 18, secs: 4350 });
  });

  it("is null for a track's title", () => {
    expect(cdToc("Will of the People")).toBeNull();
  });
});

describe("cdReleaseId", () => {
  it("reads the release from a Cover Art Archive address and from no other picture", () => {
    expect(cdReleaseId(ART)).toBe("d53751bc-0595-4a60-8425-d9a19478fb55");
    expect(cdReleaseId("http://192.168.50.45/art/7.jpg")).toBeNull();
  });
});

describe("trackTitle", () => {
  it("drops a CD's table of contents and keeps every other title", () => {
    expect(trackTitle({ class: "md.track.cd", title: TOC })).toBeNull();
    expect(trackTitle({ class: "md.track.cd", title: "Liberation" })).toBe("Liberation");
    expect(trackTitle({ class: "stream.media.upnp", title: TOC })).toBe(TOC);
  });
});
