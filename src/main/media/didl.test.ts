/**
 * DIDL-Lite → MediaNode, on hand-written synthetic documents.
 *
 * Each server shape below is the one didl.ts names in its comments, written
 * small enough to read: what the spec says first (extraction), then the
 * node rules, each of which must be a no-op on a spec-clean server. The
 * names in the fixtures are placeholders chosen to show the shape (a band
 * name with a comma in it, a featured guest), not captures from a library.
 */
import { describe, expect, it } from "vitest";
import { didlToNodes, parseDuration, pickArt, splitNames } from "./didl";
import type { MediaNode } from "@shared/model";

const didl = (body: string): string =>
  `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"` +
  ` xmlns:dc="http://purl.org/dc/elements/1.1/"` +
  ` xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"` +
  ` xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">${body}</DIDL-Lite>`;

const TRACK = "<upnp:class>object.item.audioItem.musicTrack</upnp:class>";
const ALBUM = "<upnp:class>object.container.album.musicAlbum</upnp:class>";

/** One item, parsed. */
function itemNode(inner: string, id = "t1"): MediaNode {
  const nodes = didlToNodes(didl(`<item id="${id}" parentID="a1" restricted="1">${inner}</item>`));
  expect(nodes).toHaveLength(1);
  return nodes[0];
}

/** One container, parsed. */
function albumNode(inner: string, id = "a1"): MediaNode {
  const nodes = didlToNodes(
    didl(`<container id="${id}" parentID="albums" restricted="1">${inner}</container>`),
  );
  expect(nodes).toHaveLength(1);
  return nodes[0];
}

/** A primary <res> with the given attributes. */
const res = (attrs: Record<string, string | number>, url = "http://server/t1"): string =>
  `<res ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}>${url}</res>`;

describe("extraction: a spec-clean track", () => {
  it("reads every standard field", () => {
    const node = itemNode(
      "<dc:title>Opening</dc:title>" +
        TRACK +
        "<upnp:artist>The Placeholders</upnp:artist>" +
        "<dc:creator>The Placeholders</dc:creator>" +
        "<upnp:album>First Light</upnp:album>" +
        "<dc:date>2013-05-17</dc:date>" +
        "<upnp:originalTrackNumber>3</upnp:originalTrackNumber>" +
        "<upnp:albumArtURI>http://server/art/a1.jpg</upnp:albumArtURI>" +
        res({
          protocolInfo: "http-get:*:audio/x-flac:*",
          duration: "0:03:00.000",
          size: 30_000_000,
          bitsPerSample: 24,
          sampleFrequency: 96000,
          nrAudioChannels: 2,
        }),
    );
    expect(node).toEqual({
      id: "t1",
      parentId: "a1",
      title: "Opening",
      upnpClass: "object.item.audioItem.musicTrack",
      isContainer: false,
      artUrl: "http://server/art/a1.jpg",
      artist: "The Placeholders",
      album: "First Light",
      year: "2013",
      trackNumber: 3,
      durationSecs: 180,
      // 30 MB over 180 s is 1333 kbps
      format: {
        codec: "FLAC",
        bits: 24,
        rate: 96000,
        kbps: 1333,
        sizeBytes: 30_000_000,
        channels: 2,
      },
    });
  });

  it("leaves optional fields absent, not empty, when the server sends none", () => {
    const node = itemNode("<dc:title>Bare</dc:title>" + TRACK);
    for (const key of ["genre", "albumArtist", "artists", "composers", "format", "discNumber"])
      expect(node).not.toHaveProperty(key);
    expect(node.artist).toBeNull();
    expect(node.durationSecs).toBeNull();
  });

  it("lists containers first, whatever the document order", () => {
    const nodes = didlToNodes(
      didl(
        `<item id="t1" parentID="a1"><dc:title>Track</dc:title>${TRACK}</item>` +
          `<container id="a1" parentID="0"><dc:title>Album</dc:title>${ALBUM}</container>` +
          `<item id="t2" parentID="a1"><dc:title>Track 2</dc:title>${TRACK}</item>`,
      ),
    );
    expect(nodes.map((n) => [n.id, n.isContainer])).toEqual([
      ["a1", true],
      ["t1", false],
      ["t2", false],
    ]);
  });

  it("skips an entry with no id or no title, and reads an empty or foreign document as nothing", () => {
    const nodes = didlToNodes(
      didl(
        `<item parentID="a1"><dc:title>No id</dc:title>${TRACK}</item>` +
          `<item id="t2" parentID="a1">${TRACK}</item>` +
          `<item id="t3" parentID="a1"><dc:title>Kept</dc:title>${TRACK}</item>`,
      ),
    );
    expect(nodes.map((n) => n.id)).toEqual(["t3"]);
    expect(didlToNodes(didl(""))).toEqual([]);
    expect(didlToNodes("<Result>nothing here</Result>")).toEqual([]);
  });

  it("decodes entities and trims titles", () => {
    const node = itemNode("<dc:title>  Salt &amp; Pepper  </dc:title>" + TRACK);
    expect(node.title).toBe("Salt & Pepper");
  });

  it("reads multi-disc numbers as sent, leaving a packed track number for trackPosition", () => {
    // Asset packs disc×100+track besides sending the disc: 212 is disc 2 track 12
    const node = itemNode(
      "<dc:title>Twelfth</dc:title>" +
        TRACK +
        "<upnp:originalTrackNumber>212</upnp:originalTrackNumber>" +
        "<upnp:originalDiscNumber>2</upnp:originalDiscNumber>" +
        "<upnp:originalDiscCount>2</upnp:originalDiscCount>",
    );
    expect(node).toMatchObject({ trackNumber: 212, discNumber: 2, discCount: 2 });
  });

  it("takes the first date when dc:date and upnp:date both arrive (NODE RULE dates)", () => {
    // Gerbera sends both; they fold into one array under removeNSPrefix
    const node = itemNode(
      "<dc:title>Dated</dc:title>" +
        TRACK +
        "<dc:date>1999-03-01</dc:date><upnp:date>2004</upnp:date>",
    );
    expect(node.year).toBe("1999");
  });

  it.fails("KNOWN BUG: keeps a numeric-looking title as written", () => {
    // The XML parser's number coercion reaches text content: "3.10" reads
    // 3.1, "007" reads 7, "1.0" reads 1, "0x1F" reads 31, in titles, artists
    // and albums alike. When the parser stops coercing (and the index
    // VERSION bumps with it), this test fails: drop the .fails then.
    const node = itemNode("<dc:title>3.10</dc:title>" + TRACK + "<upnp:album>007</upnp:album>");
    expect(node.title).toBe("3.10");
    expect(node.album).toBe("007");
  });
});

describe("extraction: multi-valued fields", () => {
  it("genres arrive repeated AND packed; deduplicated, first-seen casing kept", () => {
    const node = itemNode(
      "<dc:title>Genres</dc:title>" +
        TRACK +
        "<upnp:genre>Pop; Rock</upnp:genre><upnp:genre>rock</upnp:genre><upnp:genre>Jazz</upnp:genre>",
    );
    expect(node.genre).toEqual(["Pop", "Rock", "Jazz"]);
  });

  it("composers come from role=Composer and from upnp:composer, split the same way", () => {
    const node = itemNode(
      "<dc:title>Written</dc:title>" +
        TRACK +
        "<upnp:artist>Performer</upnp:artist>" +
        '<upnp:artist role="Composer">Writer One; Writer Two</upnp:artist>' +
        "<upnp:composer>Writer Three</upnp:composer>",
    );
    expect(node.composers).toEqual(["Writer One", "Writer Two", "Writer Three"]);
    // a composer is not a performer
    expect(node.artist).toBe("Performer");
    expect(node).not.toHaveProperty("artists");
  });

  it("album art: the largest DLNA profile wins, unranked entries keep first-seen order", () => {
    const node = itemNode(
      "<dc:title>Art</dc:title>" +
        TRACK +
        '<upnp:albumArtURI dlna:profileID="JPEG_TN">http://server/tn.jpg</upnp:albumArtURI>' +
        '<upnp:albumArtURI dlna:profileID="JPEG_LRG">http://server/lrg.jpg</upnp:albumArtURI>' +
        '<upnp:albumArtURI dlna:profileID="JPEG_MED">http://server/med.jpg</upnp:albumArtURI>',
    );
    expect(node.artUrl).toBe("http://server/lrg.jpg");
    expect(pickArt(["http://server/one.jpg", "http://server/two.jpg"])).toBe(
      "http://server/one.jpg",
    );
    expect(pickArt(undefined)).toBeNull();
  });

  it("splitNames splits on '; ' and ' / ' but never on ', '", () => {
    expect(splitNames(["A; B", "b ; C", "D / E"])).toEqual(["A", "B", "C", "D", "E"]);
    // a slash inside a name is not a separator; only a spaced one is
    expect(splitNames(["AC/DC"])).toEqual(["AC/DC"]);
    // ", " is unsplittable: a band name and a packed list look identical
    expect(splitNames(["Crosby, Stills, Nash & Young"])).toEqual(["Crosby, Stills, Nash & Young"]);
    expect(splitNames([null, undefined, ""])).toEqual([]);
  });
});

describe("parseDuration", () => {
  it("reads H:MM:SS with or without a fraction, and nothing else", () => {
    expect(parseDuration("0:04:35.000")).toBe(275);
    expect(parseDuration("1:02:03")).toBe(3723);
    expect(parseDuration("12:00:00")).toBe(43200);
    // the fraction is dropped, not rounded
    expect(parseDuration("0:00:59.999")).toBe(59);
    expect(parseDuration("4:35")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });
});

describe("the format of the primary <res>", () => {
  const format = (attrs: Record<string, string | number>): MediaNode["format"] =>
    itemNode("<dc:title>F</dc:title>" + TRACK + res(attrs)).format;

  it("names the codec from the mime type", () => {
    const cases: [string, string][] = [
      ["audio/x-flac", "FLAC"],
      ["audio/flac", "FLAC"],
      ["audio/mpeg", "MP3"],
      ["audio/wav", "WAV"],
      ["audio/L16", "PCM"],
      ["audio/x-aiff", "AIFF"],
      ["audio/x-ms-wma", "WMA"],
      ["audio/ogg", "OGG"],
      ["audio/opus", "Opus"],
      ["audio/x-dsf", "DSD"],
      ["audio/x-ape", "APE"],
      ["audio/x-wavpack", "WV"],
      ["audio/mp4", "AAC"],
      ["audio/x-something", "SOMETHING"],
    ];
    for (const [mime, codec] of cases)
      expect(format({ protocolInfo: `http-get:*:${mime}:*` })?.codec, mime).toBe(codec);
  });

  it.fails("KNOWN BUG: reads DLNA's LPCM mime, which carries parameters, as PCM", () => {
    // DLNA spells LPCM "audio/L16;rate=44100;channels=2"; the subtype is
    // compared with its parameters still attached, so the codec reads
    // "L16;RATE=44100;CHANNELS=2" (and, not being lossless, loses its bit
    // depth). When the parameters are stripped, this fails: drop the .fails.
    const f = format({
      protocolInfo: "http-get:*:audio/L16;rate=44100;channels=2:DLNA.ORG_PN=LPCM",
      bitsPerSample: 16,
    });
    expect(f).toMatchObject({ codec: "PCM", bits: 16 });
  });

  it("has no format for a non-audio resource", () => {
    expect(format({ protocolInfo: "http-get:*:image/jpeg:*" })).toBeUndefined();
    expect(format({ protocolInfo: "http-get:*:video/mp4:*" })).toBeUndefined();
  });

  it("keeps a bit depth only for lossless codecs", () => {
    const lossy = format({ protocolInfo: "http-get:*:audio/mpeg:*", bitsPerSample: 16 });
    expect(lossy).not.toHaveProperty("bits");
    const lossless = format({ protocolInfo: "http-get:*:audio/x-flac:*", bitsPerSample: 16 });
    expect(lossless?.bits).toBe(16);
  });

  it("an m4a is ALAC when its DLNA profile says so, or when its bitrate is past any AAC", () => {
    const pn = format({ protocolInfo: "http-get:*:audio/mp4:DLNA.ORG_PN=ALAC_M4A" });
    expect(pn?.codec).toBe("ALAC");
    // Asset labels every .m4a AAC_ISO; 3 MB a minute is 400 kbps (AAC),
    // 30 MB a minute is 4000 kbps (only a lossless file is that big)
    const small = format({
      protocolInfo: "http-get:*:audio/mp4:DLNA.ORG_PN=AAC_ISO",
      size: 3_000_000,
      duration: "0:01:00",
    });
    const big = format({
      protocolInfo: "http-get:*:audio/mp4:DLNA.ORG_PN=AAC_ISO",
      size: 30_000_000,
      duration: "0:01:00",
    });
    expect(small?.codec).toBe("AAC");
    expect(big?.codec).toBe("ALAC");
  });

  describe("NODE RULE bitrate", () => {
    it("is the file's size over its duration whenever both are known", () => {
      // the attribute (the decoded PCM rate, as Asset sends it) is ignored
      const f = format({
        protocolInfo: "http-get:*:audio/x-flac:*",
        size: 24_000_000,
        duration: "0:04:00",
        bitrate: 176400,
      });
      expect(f?.kbps).toBe(800);
    });

    it("falls back to the attribute, read as the spec's bytes per second", () => {
      const f = format({ protocolInfo: "http-get:*:audio/mpeg:*", bitrate: 40000 });
      expect(f?.kbps).toBe(320);
    });

    it("reads an attribute that would be past 24 Mbps as bits per second", () => {
      // minidlna, Jellyfin and UMS send bits/s: 4,608,000 as bytes would be
      // 36,864 kbps, which no audio file is
      const f = format({ protocolInfo: "http-get:*:audio/L24:*", bitrate: 4_608_000 });
      expect(f?.kbps).toBe(4608);
    });
  });
});

describe("NODE RULES: who the artists are", () => {
  it("role-tagged (Asset): performers packed with '; ', the AlbumArtist role apart", () => {
    const node = itemNode(
      "<dc:title>Guest Spot</dc:title>" +
        TRACK +
        '<upnp:artist role="AlbumArtist">Headliner</upnp:artist>' +
        "<upnp:artist>Headliner; Guest Singer</upnp:artist>" +
        '<upnp:artist role="Composer">Writer One; Writer Two</upnp:artist>',
    );
    expect(node.artist).toBe("Headliner; Guest Singer");
    expect(node.albumArtist).toBe("Headliner");
    expect(node.artists).toEqual(["Headliner", "Guest Singer"]);
    expect(node.composers).toEqual(["Writer One", "Writer Two"]);
  });

  it("role-less, creator disagreeing (minidlna): upnp:artist is the album artist", () => {
    // NODE RULE creator-as-performer: a compilation track names its
    // performer only as dc:creator
    const node = itemNode(
      "<dc:title>Side One</dc:title>" +
        TRACK +
        "<upnp:artist>Various Artists</upnp:artist>" +
        "<dc:creator>A Singer</dc:creator>",
    );
    expect(node.albumArtist).toBe("Various Artists");
    expect(node.artist).toBe("A Singer");
  });

  it("creator-as-performer is a no-op when the two agree, whatever the case", () => {
    const node = itemNode(
      "<dc:title>Plain</dc:title>" +
        TRACK +
        "<upnp:artist>The Placeholders</upnp:artist>" +
        "<dc:creator>THE PLACEHOLDERS</dc:creator>",
    );
    expect(node.artist).toBe("The Placeholders");
    expect(node).not.toHaveProperty("albumArtist");
  });

  it("creator-as-performer never fires when the server sends roles", () => {
    const node = itemNode(
      "<dc:title>Tagged</dc:title>" +
        TRACK +
        '<upnp:artist role="Performer">A Singer</upnp:artist>' +
        "<dc:creator>Someone Else</dc:creator>",
    );
    expect(node.artist).toBe("A Singer");
    expect(node).not.toHaveProperty("albumArtist");
  });

  it("one element per performer (Emby, Jellyfin): joined for display, listed for identity", () => {
    const node = itemNode(
      "<dc:title>Duet</dc:title>" +
        TRACK +
        "<upnp:artist>First Voice</upnp:artist><upnp:artist>Second Voice</upnp:artist>" +
        "<dc:creator>First Voice, Second Voice</dc:creator>",
    );
    expect(node.artist).toBe("First Voice; Second Voice");
    expect(node.artists).toEqual(["First Voice", "Second Voice"]);
    expect(node).not.toHaveProperty("albumArtist");
  });

  it("' / ' packing (UMS) splits; the display string stays as sent", () => {
    const node = itemNode(
      "<dc:title>Split</dc:title>" + TRACK + "<upnp:artist>One / Two</upnp:artist>",
    );
    expect(node.artist).toBe("One / Two");
    expect(node.artists).toEqual(["One", "Two"]);
  });

  it("', ' packing is left whole: it cannot be told from a band name", () => {
    const node = itemNode(
      "<dc:title>Showdown</dc:title>" +
        TRACK +
        "<upnp:artist>Albert Collins, Robert Cray &amp; Johnny Copeland</upnp:artist>",
    );
    expect(node.artist).toBe("Albert Collins, Robert Cray & Johnny Copeland");
    expect(node).not.toHaveProperty("artists");
  });

  it("falls back to dc:creator when there is no upnp:artist at all", () => {
    const node = itemNode(
      "<dc:title>Created</dc:title>" + TRACK + "<dc:creator>Maker</dc:creator>",
    );
    expect(node.artist).toBe("Maker");
  });

  describe("NODE RULE leading-album-artist (MinimServer)", () => {
    it("splits a ', ' list that begins with the track's own album artist", () => {
      const node = itemNode(
        "<dc:title>Feature</dc:title>" +
          TRACK +
          '<upnp:artist role="AlbumArtist">Headliner</upnp:artist>' +
          '<upnp:artist role="Performer">Headliner, Guest One, Guest Two</upnp:artist>',
      );
      // the headliner is one name; the rest is left whole
      expect(node.artists).toEqual(["Headliner", "Guest One, Guest Two"]);
      expect(node.artist).toBe("Headliner, Guest One, Guest Two");
    });

    it("leaves a ', ' list alone when it does not begin with the album artist", () => {
      const node = itemNode(
        "<dc:title>Band</dc:title>" +
          TRACK +
          '<upnp:artist role="AlbumArtist">Someone</upnp:artist>' +
          '<upnp:artist role="Performer">Crosby, Stills &amp; Nash</upnp:artist>',
      );
      expect(node).not.toHaveProperty("artists");
    });
  });

  describe("NODE RULE container-artist (Emby, Jellyfin, MinimServer)", () => {
    it("an album that lists its performers is credited to its AlbumArtist role", () => {
      const node = albumNode(
        "<dc:title>Big Record</dc:title>" +
          ALBUM +
          '<upnp:artist role="AlbumArtist">Headliner</upnp:artist>' +
          "<upnp:artist>Headliner</upnp:artist><upnp:artist>Guest One</upnp:artist>" +
          "<upnp:artist>Guest Two</upnp:artist>",
      );
      expect(node.artist).toBe("Headliner");
      expect(node.albumArtist).toBe("Headliner");
      expect(node).not.toHaveProperty("artists");
    });

    it("with no role, three or more names by a safe separator make Various Artists", () => {
      const node = albumNode(
        "<dc:title>Compilation</dc:title>" +
          ALBUM +
          "<upnp:artist>One</upnp:artist><upnp:artist>Two</upnp:artist><upnp:artist>Three</upnp:artist>",
      );
      expect(node.artist).toBe("Various Artists");
    });

    it("by ', ' it takes four names, since one band name can hold three", () => {
      const three = albumNode(
        "<dc:title>Deja</dc:title>" +
          ALBUM +
          "<upnp:artist>Crosby, Stills, Nash &amp; Young</upnp:artist>",
      );
      expect(three.artist).toBe("Crosby, Stills, Nash & Young");
      const four = albumNode(
        "<dc:title>Various</dc:title>" + ALBUM + "<upnp:artist>One, Two, Three, Four</upnp:artist>",
      );
      expect(four.artist).toBe("Various Artists");
    });

    it("an album with one or two names keeps them", () => {
      const one = albumNode(
        "<dc:title>Solo</dc:title>" + ALBUM + "<upnp:artist>Solo Act</upnp:artist>",
      );
      expect(one.artist).toBe("Solo Act");
      const two = albumNode(
        "<dc:title>Duets</dc:title>" +
          ALBUM +
          "<upnp:artist>First</upnp:artist><upnp:artist>Second</upnp:artist>",
      );
      expect(two.artist).toBe("First; Second");
    });
  });
});

describe("NODE RULE title-decoration (Gerbera, Plex)", () => {
  it("drops the item's own artist when the title begins with it and ' - '", () => {
    const node = itemNode(
      "<dc:title>The Placeholders - Opening</dc:title>" +
        TRACK +
        "<upnp:artist>The Placeholders</upnp:artist>",
    );
    expect(node.title).toBe("Opening");
  });

  it("keeps a title that names someone else", () => {
    const node = itemNode(
      "<dc:title>Someone Else - Song</dc:title>" +
        TRACK +
        "<upnp:artist>The Placeholders</upnp:artist>",
    );
    expect(node.title).toBe("Someone Else - Song");
  });

  it("drops a container's ' (YEAR)' only when it is the container's own year", () => {
    const own = albumNode(
      "<dc:title>Record (2001)</dc:title>" + ALBUM + "<dc:date>2001-03-12</dc:date>",
    );
    expect(own.title).toBe("Record");
    const other = albumNode(
      "<dc:title>Record (1999)</dc:title>" + ALBUM + "<dc:date>2001</dc:date>",
    );
    expect(other.title).toBe("Record (1999)");
    // a track's title is never trimmed that way
    const track = itemNode("<dc:title>Song (2001)</dc:title>" + TRACK + "<dc:date>2001</dc:date>");
    expect(track.title).toBe("Song (2001)");
  });
});
