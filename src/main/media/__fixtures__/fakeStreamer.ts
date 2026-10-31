/**
 * TEST-ONLY: a streamer and its own media server for the unit tests of the media layer
 * (upnpBrowser, mediaIndex, mediaInfo). Nothing in the app imports this. A small fork of the
 * harness mock (dev/mock-streamer.mjs, which CI does not have), its response shapes copied:
 * /smoip/system/upnp lists one server on the streamer's own address ("Mock Evo", mock-udn-1),
 * its description names a ContentDirectory, and that answers Browse (150 at a time, as real
 * servers cap it), Search (scoped by class, on the fields the criteria name), the capability
 * calls and the counter.
 *
 * The library is a slice of the mock's: Amber Nights, Godzone Mix (a compilation), Dark Skies
 * twice (two editions), Plain Sleeve, Formula One and Two, the 35 albums of Mock Artist 2's
 * discography, four loose singles, and an Artists folder. The options are the mock's knobs:
 * searchCaps (MOCK_SEARCH_CAPS; "" is the streamer's USB server, Browse-only), rotatingIds
 * (MOCK_ROTATING_IDS: every id prefixed by a mount that rotate() moves with the counter, an
 * old one "no such object", and a deep folder chain under Music), usbFolders (MOCK_USB_FOLDERS:
 * the albums are the drive's folders, "Artist - Album" with no artist and no date, the tracks
 * keeping their tags) and searchPaged (MOCK_SEARCH_PAGED: Search honors StartingIndex and
 * RequestedCount, 150 at most). `artists` is the Artists folder's size (the mock's 400): a walk
 * lists every artist's folder, so a test that walks keeps it small. holdUpnp (MOCK_UPNP_DELAY_MS)
 * keeps the streamer's server listing unanswered until releaseUpnp(), rather than for a time.
 * assetIds (MOCK_SECOND_BLANK, with the mock's /__test/media2/remint) gives every id a generation
 * that remint() moves with the counter held, as Asset re-minted his library (0.13.0-rc.6), and an
 * id of another generation answers as Asset answers one it no longer has: HTTP 200 and a blank,
 * a container "-1" with an empty title, or an empty listing.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeStreamerOptions {
  searchCaps?: string;
  rotatingIds?: boolean;
  usbFolders?: boolean;
  searchPaged?: boolean;
  artists?: number;
  holdUpnp?: boolean;
  assetIds?: boolean;
}

export interface FakeStreamer {
  /** "127.0.0.1:port", the app's host string for the streamer. */
  host: string;
  /** How many Search requests the server has answered. */
  readonly searchCalls: number;
  /** How many queue writes (/smoip/queue/add) the streamer took. */
  readonly queueAdds: number;
  /** A standby or a replug: the mount moves, so every id is re-minted, and the counter with it. */
  rotate(): void;
  /** assetIds: every id re-minted, the counter where it was. */
  remint(): void;
  /** Answers the server listing held by holdUpnp. */
  releaseUpnp(): void;
  stop(): Promise<void>;
}

interface Track {
  title: string;
  artist: string;
  album: string;
  albumArtist?: string;
  composer?: string;
  art: string | null;
  secs: number;
}

interface Album {
  id: string;
  title: string;
  artist: string;
  date: string;
  art: string | null;
  genres: string[];
  tracks: Track[];
}

const SYN_GENRES = [
  "House",
  "Techno",
  "IDM",
  "Trance",
  "Breakbeat",
  "Dub",
  "Chillout",
  "Garage",
  "Electro",
  "Acid",
];

const xmlEsc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const durFmt = (secs: number): string =>
  `0:${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}.000`;
/** What Asset answers for an id it no longer has (his library, 2026-10-28): HTTP 200 and this. */
const ASSET_BLANK =
  '<container id="-1" parentID="-1" restricted="0" searchable="1"><dc:title></dc:title><dc:creator> </dc:creator><upnp:genre>Unknown</upnp:genre><upnp:class>object.container</upnp:class></container>';

const didlWrap = (inner: string): string =>
  `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${inner}</DIDL-Lite>`;
const didlArt = (art: string | null): string =>
  art == null ? "" : `<upnp:albumArtURI>${art}</upnp:albumArtURI>`;
const didlContainer = (
  id: string,
  parent: string,
  title: string,
  cls: string,
  art: string | null,
  artist?: string,
  date?: string,
  genres?: string[],
): string =>
  `<container id="${id}" parentID="${parent}" restricted="true"><upnp:class>${cls}</upnp:class><dc:title>${xmlEsc(title)}</dc:title>${didlArt(art)}${artist ? `<upnp:artist>${xmlEsc(artist)}</upnp:artist>` : ""}${date ? `<dc:date>${date}</dc:date>` : ""}${(genres ?? []).map((g) => `<upnp:genre>${xmlEsc(g)}</upnp:genre>`).join("")}</container>`;
// with an album artist, three upnp:artist elements (AlbumArtist role, the performers, the
// Composer role) and dc:creator repeating the performers; without, one plain element
const didlArtists = (t: Track): string =>
  t.albumArtist
    ? `<dc:creator>${xmlEsc(t.artist)}</dc:creator><upnp:artist role="AlbumArtist">${xmlEsc(t.albumArtist)}</upnp:artist><upnp:artist>${xmlEsc(t.artist)}</upnp:artist>${t.composer ? `<upnp:artist role="Composer">${xmlEsc(t.composer)}</upnp:artist>` : ""}`
    : `<upnp:artist>${xmlEsc(t.artist)}</upnp:artist>${t.composer ? `<upnp:artist role="Composer">${xmlEsc(t.composer)}</upnp:artist>` : ""}`;
const didlTrack = (alb: Album, n: number, parent = alb.id): string => {
  const t = alb.tracks[n - 1];
  return `<item id="${alb.id}-t${n}" parentID="${parent}" restricted="true"><dc:title>${xmlEsc(t.title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>${didlArtists(t)}<upnp:album>${xmlEsc(t.album)}</upnp:album>${alb.genres.map((g) => `<upnp:genre>${xmlEsc(g)}</upnp:genre>`).join("")}<upnp:originalTrackNumber>${n}</upnp:originalTrackNumber>${didlArt(t.art)}<res duration="${durFmt(t.secs)}" size="${t.secs * 100000}" bitrate="176400" bitsPerSample="16" sampleFrequency="44100" nrAudioChannels="2" protocolInfo="http-get:*:audio/x-flac:DLNA.ORG_PN=FLAC;DLNA.ORG_OP=01">file:///tmp/usm/1/${alb.id}/${n}.flac</res></item>`;
};
const didlLooseTrack = (id: string, parent: string, title: string, artist: string, art: string) =>
  `<item id="${id}" parentID="${parent}" restricted="true"><dc:title>${xmlEsc(title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><upnp:artist>${xmlEsc(artist)}</upnp:artist>${didlArt(art)}<res duration="0:03:00.000" protocolInfo="*:*:*:*">file:///tmp/usm/1/singles/${id}.flac</res></item>`;

const SINGLES: Array<[string, string, string]> = [
  ["sng-1", "Zeta Song", "The Mock Artists"],
  ["sng-2", "Alpha Song", "The Neon Collective"],
  ["sng-3", "Middle Song", "The Mock Artists"],
  ["sng-4", "Orphan Signal", "Lone Cassette"],
];

const artistName = (n: number): string =>
  n % 7 === 0 ? `Artist & Friends ${n}` : `Mock Artist ${n}`;

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => resolve(body));
  });

export async function startFakeStreamer(opts: FakeStreamerOptions = {}): Promise<FakeStreamer> {
  const searchCaps = opts.searchCaps ?? "*";
  const rotating = opts.rotatingIds === true;
  const folders = rotating && opts.usbFolders === true;
  const artistCount = opts.artists ?? 400;
  let mount = 26;
  let updateId = 3;
  let searchCalls = 0;
  let queueAdds = 0;
  const assetIds = opts.assetIds === true;
  let generation = 1;
  let releaseUpnp = (): void => {};
  const upnpHeld = opts.holdUpnp
    ? new Promise<void>((r) => {
        releaseUpnp = r;
      })
    : null;

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = `http://${host}`;
  const art = (name: string): string => `${origin}/art/${name}.svg`;

  const amber: Album = {
    id: "alb-1",
    title: "Amber Nights",
    artist: "The Mock Artists",
    date: "2011-03-14",
    art: art("p1"),
    genres: ["Electronic"],
    // track 8 reuses track 7's title (a reprise), as the mock's does
    tracks: Array.from({ length: 8 }, (_, i) => ({
      title: `Mock Track ${i === 7 ? 7 : i + 1}`,
      artist: "The Mock Artists",
      album: "Amber Nights",
      composer: "Amber Writer",
      art: art(`q${i + 1}`),
      secs: 180 + (i + 1) * 7,
    })),
  };
  const godzone: Album = {
    id: "alb-3",
    title: "Godzone Mix",
    artist: "Various Artists",
    date: "2002-01-01",
    art: art("p3"),
    genres: ["New Zealand"],
    tracks: ["Coconut Rough", "Citizen Band", "Che Fu"].map((performer, i) => ({
      title: `Godzone ${i + 1}`,
      artist: performer,
      album: "Godzone Mix",
      albumArtist: "Various Artists",
      art: art("p3"),
      secs: 180 + i + 1,
    })),
  };
  // two editions of one album: the same title, artist and year, each with its own art
  const darkSkies = (id: string, cover: string): Album => ({
    id,
    title: "Dark Skies",
    artist: "The Neon Collective",
    date: "2016-05-05",
    art: art(cover),
    genres: ["Synthpop"],
    tracks: [1, 2].map((n) => ({
      title: `Dark Skies ${n}`,
      artist: "The Neon Collective",
      album: "Dark Skies",
      art: art(cover),
      secs: 200 + n,
    })),
  });
  const plain = (
    id: string,
    title: string,
    date: string,
    cover: string | null,
    trackTitle: (n: number) => string,
    base: number,
  ): Album => ({
    id,
    title,
    artist: "The Mock Artists",
    date,
    art: cover,
    genres: ["Electronic"],
    tracks: [1, 2].map((n) => ({
      title: trackTitle(n),
      artist: "The Mock Artists",
      album: title,
      art: cover,
      secs: base + n,
    })),
  });
  const LIB: Album[] = [
    amber,
    godzone,
    darkSkies("alb-4", "p4"),
    darkSkies("alb-5", "p5"),
    plain("alb-10-1", "Formula One", "2016-01-01", art("p1"), (n) => `Formula 1-${n}`, 80),
    plain("alb-10-2", "Formula Two", "2016-02-01", art("p2"), (n) => `Formula 2-${n}`, 90),
    // an artless album: neither the container nor its tracks carry art
    plain("alb-6", "Plain Sleeve", "2020-01-01", null, (n) => `Plain Track ${n}`, 150),
  ];
  // Mock Artist 2's discography, the 35 albums under the artist's folder
  const SYN: Album[] = Array.from({ length: 35 }, (_, i) => ({
    id: `syn-${i + 1}`,
    title: `Synth Album ${i + 1}`,
    artist: `Mock Artist ${(i % 30) + 1}`,
    date: `${1980 + i}-01-01`,
    art: null,
    genres: [SYN_GENRES[i % SYN_GENRES.length]],
    tracks: [1, 2].map((n) => ({
      title: `Synth ${i + 1}.${n}`,
      artist: `Mock Artist ${(i % 30) + 1}`,
      album: `Synth Album ${i + 1}`,
      art: null,
      secs: 90 + n,
    })),
  }));
  // with rotating ids, a deep folder chain under Music ends in an album, as on the mock
  const DEEP: Album = {
    id: "alb-deep",
    title: "Deep Album",
    artist: "The Mock Artists",
    date: "1995-06-01",
    art: null,
    genres: ["Rock"],
    tracks: [1, 2].map((n) => ({
      title: `Deep Track ${n}`,
      artist: "The Mock Artists",
      album: "Deep Album",
      art: null,
      secs: 180 + n * 7,
    })),
  };
  const DEEP_FOLDERS: Record<string, [string, string]> = {
    "deep-boxes": ["lib-music", "Boxes and Bootlegs Collection"],
    "deep-rock": ["deep-boxes", "Rock and Alternative"],
    "deep-nineties": ["deep-rock", "The Nineties Reissues"],
  };
  const albumById = (id: string): Album | undefined =>
    [...LIB, ...SYN, ...(rotating ? [DEEP] : [])].find((a) => a.id === id);
  const albumNode = (a: Album, parent: string): string =>
    didlContainer(
      a.id,
      parent,
      a.title,
      "object.container.album.musicAlbum",
      a.art,
      a.artist,
      a.date,
      a.genres,
    );

  const cdChildren = (id: string): string[] | null => {
    if (id === "0")
      return [
        didlContainer("lib-music", "0", "Music", "object.container", null),
        didlContainer("lib-artists", "0", "Artists", "object.container", null),
        didlContainer("lib-singles", "0", "Singles", "object.container", null),
      ];
    if (id === "lib-music")
      return [
        ...LIB.map((a) => albumNode(a, "lib-music")),
        ...(rotating
          ? [
              didlContainer(
                "deep-boxes",
                "lib-music",
                DEEP_FOLDERS["deep-boxes"][1],
                "object.container",
                null,
              ),
            ]
          : []),
        // a loose track alongside the albums
        didlTrack(amber, 1),
      ];
    if (rotating && id === "deep-boxes")
      return [
        didlContainer("deep-rock", id, DEEP_FOLDERS["deep-rock"][1], "object.container", null),
      ];
    if (rotating && id === "deep-rock")
      return [
        didlContainer(
          "deep-nineties",
          id,
          DEEP_FOLDERS["deep-nineties"][1],
          "object.container",
          null,
        ),
      ];
    if (rotating && id === "deep-nineties") return [albumNode(DEEP, id)];
    if (id === "lib-singles")
      return SINGLES.map(([sid, title, artist], i) =>
        didlLooseTrack(sid, "lib-singles", title, artist, art(`p${i + 11}`)),
      );
    if (id === "lib-artists")
      return [
        // a virtual view: the bare person class, no musicArtist leaf
        didlContainer(
          "art-all",
          "lib-artists",
          "[All Artists]",
          "object.container.person",
          art("p9"),
        ),
        ...Array.from({ length: artistCount }, (_, i) =>
          didlContainer(
            `art-${i + 1}`,
            "lib-artists",
            artistName(i + 1),
            "object.container.person.musicArtist",
            i < 8 ? art(`p${(i % 24) + 1}`) : null,
          ),
        ),
      ];
    const artistFolder = /^art-(\d+)$/.exec(id);
    if (artistFolder)
      return [
        didlContainer(`${id}-alltracks`, id, " [All Tracks]", "object.container", null),
        didlContainer(`${id}-shuffle`, id, " [Shuffle Tracks]", "object.container", null),
        ...(artistFolder[1] === "2" ? SYN : LIB).map((a) => albumNode(a, id)),
      ];
    if (/^art-\d+-(alltracks|shuffle)$/.test(id))
      return LIB.flatMap((a) => a.tracks.map((_, i) => didlTrack(a, i + 1)));
    const alb = albumById(id);
    return alb ? alb.tracks.map((_, i) => didlTrack(alb, i + 1)) : null;
  };
  const cdMetadata = (id: string): string | null => {
    const deep = rotating ? DEEP_FOLDERS[id] : undefined;
    if (deep) return didlContainer(id, deep[0], deep[1], "object.container", null);
    if (id === "lib-music") return didlContainer(id, "0", "Music", "object.container", null);
    if (id === "lib-singles") return didlContainer(id, "0", "Singles", "object.container", null);
    if (id === "lib-artists") return didlContainer(id, "0", "Artists", "object.container", null);
    const alb = albumById(id);
    if (alb) return albumNode(alb, rotating && alb === DEEP ? "deep-nineties" : "lib-music");
    const t = /^(.+)-t(\d+)$/.exec(id);
    const of = t ? albumById(t[1]) : undefined;
    if (t && of && Number(t[2]) >= 1 && Number(t[2]) <= of.tracks.length)
      return didlTrack(of, Number(t[2]));
    const sng = SINGLES.findIndex(([sid]) => sid === id);
    return sng >= 0
      ? didlLooseTrack(id, "lib-singles", SINGLES[sng][1], SINGLES[sng][2], art(`p${sng + 11}`))
      : null;
  };
  // the mount prefixes every id but the root's, as the Evo's USB server mints them
  const mountIds = (didl: string): string =>
    didl
      .replace(/ id="([^"]+)"/g, (_, id: string) =>
        id === "0" ? ' id="0"' : ` id="${mount}:${id}"`,
      )
      .replace(/ parentID="([^"]+)"/g, (_, id: string) =>
        id === "0" ? ' parentID="0"' : ` parentID="${mount}:${id}"`,
      );
  // assetIds: the generation prefixes every id but the root's
  const generationIds = (didl: string): string =>
    assetIds
      ? didl
          .replace(/ id="([^"]+)"/g, (_, id: string) =>
            id === "0" ? ' id="0"' : ` id="g${generation}~${id}"`,
          )
          .replace(/ parentID="([^"]+)"/g, (_, id: string) =>
            id === "0" ? ' parentID="0"' : ` parentID="g${generation}~${id}"`,
          )
      : didl;
  // the drive's albums are its folders: titled "Artist - Album", no artist and no date
  const usbFolders = (didl: string): string =>
    folders
      ? didl.replace(/<container\b[^>]*>[\s\S]*?<\/container>/g, (c) => {
          if (!c.includes("<upnp:class>object.container.album.musicAlbum</upnp:class>")) return c;
          const artist = /<upnp:artist(?: [^>]*)?>([^<]*)<\/upnp:artist>/.exec(c)?.[1];
          return c
            .replace(/<dc:title>([^<]*)<\/dc:title>/, (_, t: string) =>
              artist ? `<dc:title>${artist} - ${t}</dc:title>` : `<dc:title>${t}</dc:title>`,
            )
            .replace(/<upnp:artist(?: [^>]*)?>[^<]*<\/upnp:artist>/g, "")
            .replace(/<dc:creator>[^<]*<\/dc:creator>/g, "")
            .replace(/<dc:date>[^<]*<\/dc:date>/g, "");
        })
      : didl;

  const search = (body: string): { parts: string[] } => {
    const q = (/contains &quot;(.*?)&quot;/.exec(body)?.[1] ?? "").toLowerCase();
    const scope = /derivedfrom &quot;(.*?)&quot;/.exec(body)?.[1] ?? "";
    const useArtist = body.includes("upnp:artist contains");
    const useAlbum = body.includes("upnp:album contains");
    const parts: string[] = [];
    if (scope.includes("container.album")) {
      // the whole catalog answers a class search, in the base class (no musicAlbum leaf)
      for (const a of [...LIB, ...SYN])
        if (a.title.toLowerCase().includes(q) || (useArtist && a.artist.toLowerCase().includes(q)))
          parts.push(
            didlContainer(
              a.id,
              "lib-music",
              a.title,
              "object.container.album",
              a.art,
              a.artist,
              a.date,
              a.genres,
            ),
          );
    } else if (scope.includes("item.audioItem")) {
      for (const a of [...LIB, SYN[34]])
        a.tracks.forEach((t, i) => {
          if (
            t.title.toLowerCase().includes(q) ||
            (useArtist && t.artist.toLowerCase().includes(q)) ||
            (useAlbum && t.album.toLowerCase().includes(q))
          )
            parts.push(didlTrack(a, i + 1, "lib-title-view"));
        });
      for (const [sid, title, artist] of SINGLES)
        if (title.toLowerCase().includes(q) || (useArtist && artist.toLowerCase().includes(q)))
          parts.push(didlLooseTrack(sid, "lib-singles", title, artist, art("p11")));
    } else if (scope.includes("container.person")) {
      for (let i = 1; i <= artistCount; i++) {
        const name = artistName(i);
        if (name.toLowerCase().includes(q))
          parts.push(
            didlContainer(
              `art-${i}`,
              "lib-artists",
              name,
              "object.container.person",
              i <= 8 ? art(`p${(i % 24) + 1}`) : null,
            ),
          );
      }
    }
    return { parts };
  };

  const soap = (inner: string): string => `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`;
  const DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Mock Evo</friendlyName>
    <manufacturer>Cambridge Audio</manufacturer>
    <UDN>uuid:mock-udn-1</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <controlURL>/upnp/control</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

  server.on("request", (req, res) => {
    void (async () => {
      const u = new URL(req.url ?? "/", origin);
      const xml = (status: number, body: string): void => {
        res.writeHead(status, { "content-type": "text/xml" });
        res.end(body);
      };
      if (u.pathname === "/smoip/queue/add") {
        queueAdds++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (u.pathname === "/smoip/system/upnp") {
        if (upnpHeld) await upnpHeld;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              devices: [
                {
                  model: "EVO150",
                  name: "Mock Evo",
                  manufacturer: "Cambridge Audio",
                  udn: "mock-udn-1",
                  description_url: `${origin}/description.xml`,
                },
              ],
            },
          }),
        );
        return;
      }
      if (u.pathname === "/description.xml") return xml(200, DESCRIPTION);
      if (u.pathname !== "/upnp/control" || req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readBody(req);
      const cd = 'xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"';
      if (body.includes("GetSystemUpdateID"))
        return xml(
          200,
          soap(
            `<u:GetSystemUpdateIDResponse ${cd}><Id>${updateId}</Id></u:GetSystemUpdateIDResponse>`,
          ),
        );
      if (body.includes("GetSearchCapabilities"))
        return xml(
          200,
          soap(
            `<u:GetSearchCapabilitiesResponse ${cd}><SearchCaps>${searchCaps}</SearchCaps></u:GetSearchCapabilitiesResponse>`,
          ),
        );
      if (body.includes("GetSortCapabilities"))
        return xml(
          200,
          soap(
            `<u:GetSortCapabilitiesResponse ${cd}><SortCaps></SortCaps></u:GetSortCapabilitiesResponse>`,
          ),
        );
      const start = Number(/<StartingIndex>(\d+)<\/StartingIndex>/.exec(body)?.[1] ?? 0);
      if (body.includes("<u:Search")) {
        searchCalls++;
        const { parts } = search(body);
        const asked = Number(/<RequestedCount>(\d+)<\/RequestedCount>/.exec(body)?.[1] ?? 0);
        const page = opts.searchPaged
          ? parts.slice(start, start + Math.min(150, asked || parts.length))
          : parts;
        return xml(
          200,
          soap(
            `<u:SearchResponse ${cd}><Result>${xmlEsc(generationIds(didlWrap(page.join(""))))}</Result><NumberReturned>${page.length}</NumberReturned><TotalMatches>${parts.length}</TotalMatches><UpdateID>1</UpdateID></u:SearchResponse>`,
          ),
        );
      }
      let objectId = /<ObjectID>(.*?)<\/ObjectID>/.exec(body)?.[1] ?? "0";
      if (rotating && objectId !== "0") {
        // a mount-prefixed id: the current mount answers, any other is gone
        const m = /^(\d+):(.*)$/.exec(objectId);
        if (!m || Number(m[1]) !== mount) return xml(500, "no such object");
        objectId = m[2];
      }
      const meta = /<BrowseFlag>BrowseMetadata<\/BrowseFlag>/.test(body);
      if (assetIds && objectId !== "0") {
        // this generation's id answers; another's, as Asset answers an id it no longer has
        const g = /^g(\d+)~(.*)$/.exec(objectId);
        if (!g || Number(g[1]) !== generation) {
          const blank = meta ? ASSET_BLANK : "";
          return xml(
            200,
            soap(
              `<u:BrowseResponse ${cd}><Result>${xmlEsc(didlWrap(blank))}</Result><NumberReturned>${meta ? 1 : 0}</NumberReturned><TotalMatches>${meta ? 1 : 0}</TotalMatches><UpdateID>1</UpdateID></u:BrowseResponse>`,
            ),
          );
        }
        objectId = g[2];
      }
      const one = meta ? cdMetadata(objectId) : null;
      const all = meta ? (one ? [one] : null) : cdChildren(objectId);
      if (!all) return xml(500, "no such object");
      const parts = all.slice(start, start + 150);
      const didl = didlWrap(parts.join(""));
      const result = rotating ? usbFolders(mountIds(didl)) : generationIds(didl);
      return xml(
        200,
        soap(
          `<u:BrowseResponse ${cd}><Result>${xmlEsc(result)}</Result><NumberReturned>${parts.length}</NumberReturned><TotalMatches>${all.length}</TotalMatches><UpdateID>1</UpdateID></u:BrowseResponse>`,
        ),
      );
    })();
  });

  return {
    host,
    get searchCalls() {
      return searchCalls;
    },
    get queueAdds() {
      return queueAdds;
    },
    rotate() {
      mount++;
      updateId++;
    },
    remint() {
      generation++;
    },
    releaseUpnp: () => releaseUpnp(),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
