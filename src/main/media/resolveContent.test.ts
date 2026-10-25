/**
 * The content answers against the streamer's own USB server: a Browse-only ContentDirectory
 * whose ids carry a mount number that moves across a standby or a replug. The modules run as
 * in the app, against a fake streamer served from this file (the parts of the suite's mock
 * these checks lean on: the rotating mount, the silence and the torn body, an EFI partition,
 * the drive that forgets its folders, the re-minted pictures, a second server on its own
 * origin). Each block below takes fresh modules and its own userData, and its tests run in
 * order on one fake, each building on the state the one before left.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ContentRef, MediaInfoQuery, MediaServerInfo } from "@shared/model";

const paths = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => {
  const app = {
    getPath: () => paths.userData,
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => app,
    once: () => app,
  };
  const webContents = { getAllWebContents: () => [] };
  return {
    default: { app, webContents, nativeImage: {}, session: {} },
    app,
    webContents,
    nativeImage: {},
    session: {},
  };
});

const load = async () => {
  vi.resetModules();
  const resolve = await import("./resolveContent");
  const index = await import("./mediaIndex");
  const browser = await import("./upnpBrowser");
  const info = await import("./mediaInfo");
  return { ...resolve, ...index, ...browser, ...info };
};
type Media = Awaited<ReturnType<typeof load>>;
const dirs: string[] = [];
async function freshMedia(): Promise<Media> {
  paths.userData = mkdtempSync(join(tmpdir(), "tt-resolve-"));
  dirs.push(paths.userData);
  mkdirSync(join(paths.userData, "cache"), { recursive: true });
  return load();
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const OWN = "mock-udn-1";
const ref: ContentRef = {
  title: "Mock Track 3",
  artist: "The Mock Artists",
  album: "Amber Nights",
};
const amber: MediaInfoQuery = { kind: "album", title: "Amber Nights", artist: "The Mock Artists" };

// ------------------------------------------------------------------ the fake streamer

interface Track {
  title: string;
  artist: string;
  album: string;
  duration: number;
  art: string | null;
  composer?: string;
}
interface Album {
  id: string;
  title: string;
  artist: string;
  date: string;
  art: string | null;
  count: number;
  genres: string[];
  track(n: number): Track;
}
interface FakeOptions {
  /** A second media server, searchable, on its own origin. */
  secondServer?: boolean;
  /** An EFI partition listed first at the drive's top, both renumbered on every rotation. */
  partitions?: boolean;
  /** Evo-shaped ids (the mount, then the child positions down the drive), each known only
   *  once its folder has been listed since the last rotation. */
  forgets?: boolean;
  /** With forgets: how long a folder's first listing after a rotation takes. */
  coldMs?: number;
  /** The Evo's picture addresses, re-minted on every rotation, an old one a 404. */
  usbArt?: boolean;
}
interface FakeStats {
  updateId: number;
  mount: number;
  cdCalls: number;
  upnpListings: number;
  flaps: number;
  listed: string[];
}
interface FakeEvo {
  host: string;
  origin: string;
  origin2: string;
  stats(): FakeStats;
  resetCounters(): void;
  /** A standby or a replug: the mount moves, and the counter with it unless held. */
  rotate(opts?: { holdCounter?: boolean; retitle?: boolean }): void;
  /** The next Browse is never answered and the device goes down for a spell. */
  armFlap(seconds: number, opts: { reset: boolean; torn?: boolean }): void;
  stop(): Promise<void>;
}

const xmlEsc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const durFmt = (secs: number): string =>
  `0:${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}.000`;
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
  genres: string[] = [],
): string =>
  `<container id="${id}" parentID="${parent}" restricted="true"><upnp:class>${cls}</upnp:class><dc:title>${xmlEsc(title)}</dc:title>${didlArt(art)}${artist ? `<upnp:artist>${xmlEsc(artist)}</upnp:artist>` : ""}${date ? `<dc:date>${date}</dc:date>` : ""}${genres.map((g) => `<upnp:genre>${xmlEsc(g)}</upnp:genre>`).join("")}</container>`;
const didlTrack = (alb: Album, n: number, parent = alb.id, id = `${alb.id}-t${n}`): string => {
  const md = alb.track(n);
  return `<item id="${id}" parentID="${parent}" restricted="true"><dc:title>${xmlEsc(md.title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><upnp:artist>${xmlEsc(md.artist)}</upnp:artist>${md.composer ? `<upnp:artist role="Composer">${xmlEsc(md.composer)}</upnp:artist>` : ""}<upnp:album>${xmlEsc(md.album)}</upnp:album>${alb.genres.map((g) => `<upnp:genre>${xmlEsc(g)}</upnp:genre>`).join("")}<upnp:originalTrackNumber>${n}</upnp:originalTrackNumber>${didlArt(md.art)}<res duration="${durFmt(md.duration)}" size="${md.duration * 100000}" bitrate="176400" bitsPerSample="16" sampleFrequency="44100" nrAudioChannels="2" protocolInfo="http-get:*:audio/x-flac:DLNA.ORG_PN=FLAC;DLNA.ORG_OP=01">file:///tmp/usm/1/${alb.id}/${n}.flac</res></item>`;
};
const didlLooseTrack = (
  id: string,
  parent: string,
  title: string,
  artist: string,
  art: string,
): string =>
  `<item id="${id}" parentID="${parent}" restricted="true"><dc:title>${xmlEsc(title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><upnp:artist>${xmlEsc(artist)}</upnp:artist>${didlArt(art)}<res duration="0:03:00.000" protocolInfo="*:*:*:*">file:///tmp/usm/1/singles/${id}.flac</res></item>`;
const envelope = (inner: string): string =>
  `<?xml version="1.0"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`;
const browseResponse = (didl: string, returned: number, total: number): string =>
  `<u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Result>${xmlEsc(didl)}</Result><NumberReturned>${returned}</NumberReturned><TotalMatches>${total}</TotalMatches><UpdateID>1</UpdateID></u:BrowseResponse>`;
const description = (name: string, udn: string, control: string): string =>
  `<?xml version="1.0"?>\n<root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>${name}</friendlyName><UDN>uuid:${udn}</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><controlURL>${control}</controlURL></service></serviceList></device></root>`;
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => resolve(body));
  });
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>';

async function startFakeEvo(opts: FakeOptions = {}): Promise<FakeEvo> {
  let origin = "";
  let origin2 = "";
  let updateId = 3;
  let mount = 26;
  const step = opts.partitions ? 2 : 1;
  const coldMs = opts.coldMs ?? 1000;
  /** The folders (by path) listed since the last rotation. */
  const listed = new Set<string>();
  let rotated = false;
  let retitled = false;
  let cdCalls = 0;
  let upnpListings = 0;
  let flaps = 0;
  let flapArmed = 0;
  let flapReset = true;
  let flapTorn = false;
  let relisten: NodeJS.Timeout | null = null;
  let stopped = false;
  const artKeys = new Map<string, number>();
  const artOrigins: string[] = [];

  // the drive: Music (albums, a deep folder chain, a loose track), Artists (each artist's
  // folder listing the albums again beside two furniture folders), Singles and an Attic
  const trackMeta = (n: number): Track => ({
    title: `Mock Track ${n}`,
    artist: "The Mock Artists",
    album: "Amber Nights",
    duration: 180 + n * 7,
    art: `${origin}/art/q${n}.svg`,
  });
  const LIB: Album[] = [
    {
      id: "alb-1",
      title: "Amber Nights",
      artist: "The Mock Artists",
      date: "2011-03-14",
      art: `${origin}/art/p1.svg`,
      count: 8,
      genres: ["Electronic"],
      track: (n) => ({
        ...trackMeta(n),
        composer: "Amber Writer",
        ...(n === 8 ? { title: "Mock Track 7" } : {}),
      }),
    },
    {
      id: "alb-2",
      title: "Neon Evenings",
      artist: "The Neon Collective",
      date: "2014-06-01",
      art: `${origin}/art/p2.svg`,
      count: 5,
      genres: ["Synthpop"],
      track: (n) => ({
        ...trackMeta(n),
        title: `Neon Track ${n}`,
        album: "Neon Evenings",
        artist: "The Neon Collective",
        art: `${origin}/art/p2.svg`,
        duration: 120 + n * 11,
      }),
    },
    {
      id: "alb-6",
      title: "Plain Sleeve",
      artist: "The Mock Artists",
      date: "2020-01-01",
      art: null,
      count: 2,
      genres: ["Electronic"],
      track: (n) => ({
        ...trackMeta(n),
        title: `Plain Track ${n}`,
        album: "Plain Sleeve",
        art: null,
        duration: 150 + n,
      }),
    },
  ];
  const DEEP: Album = {
    id: "alb-deep",
    title: "Deep Album",
    artist: "The Mock Artists",
    date: "1995-06-01",
    art: null,
    count: 2,
    genres: ["Rock"],
    track: (n) => ({ ...trackMeta(n), title: `Deep Track ${n}`, album: "Deep Album" }),
  };
  const DEEP_FOLDERS: Record<string, [string, string]> = {
    "deep-boxes": ["lib-music", "Boxes and Bootlegs Collection"],
    "deep-rock": ["deep-boxes", "Rock and Alternative"],
    "deep-nineties": ["deep-rock", "The Nineties Reissues"],
  };
  const SINGLES = [
    ["sng-1", "Zeta Song", "The Mock Artists"],
    ["sng-2", "Alpha Song", "The Neon Collective"],
    ["sng-3", "Middle Song", "The Mock Artists"],
    ["sng-4", "Orphan Signal", "Lone Cassette"],
  ] as const;
  const ARTIST_COUNT = 8;
  const artistName = (n: number): string =>
    n % 7 === 0 ? `Artist & Friends ${n}` : `Mock Artist ${n}`;
  const albumContainer = (a: Album, parent: string): string =>
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
  const allTracks = (): string[] =>
    LIB.flatMap((a) => Array.from({ length: a.count }, (_, i) => didlTrack(a, i + 1)));
  const singles = (parent: string, prefix = ""): string[] =>
    SINGLES.map(([sid, title, artist], i) =>
      didlLooseTrack(`${prefix}${sid}`, parent, title, artist, `${origin}/art/p${i + 11}.svg`),
    );

  function cdChildren(id: string): string[] | null {
    if (id === "0")
      return [
        didlContainer("lib-music", "0", "Music", "object.container", null),
        didlContainer("lib-artists", "0", "Artists", "object.container", null),
        didlContainer("lib-singles", "0", "Singles", "object.container", null),
        didlContainer("lib-attic", "0", "Attic", "object.container", null),
      ];
    if (id === "deep-boxes")
      return [didlContainer("deep-rock", id, "Rock and Alternative", "object.container", null)];
    if (id === "deep-rock")
      return [
        didlContainer("deep-nineties", id, "The Nineties Reissues", "object.container", null),
      ];
    if (id === "deep-nineties") return [albumContainer(DEEP, id)];
    if (id === DEEP.id) return Array.from({ length: DEEP.count }, (_, i) => didlTrack(DEEP, i + 1));
    if (id === "lib-attic")
      return [
        didlContainer("attic-boot", id, "[Bootlegs]", "object.container", null),
        didlContainer("attic-live", id, "Live Tapes", "object.container", null),
      ];
    if (id === "attic-boot" || id === "attic-live") return singles(id, `${id}-`);
    if (id === "lib-singles") return singles(id);
    if (id === "lib-artists")
      return [
        didlContainer(
          "art-all",
          id,
          "[All Artists]",
          "object.container.person",
          `${origin}/art/p9.svg`,
        ),
        ...Array.from({ length: ARTIST_COUNT }, (_, i) =>
          didlContainer(
            `art-${i + 1}`,
            id,
            artistName(i + 1),
            "object.container.person.musicArtist",
            `${origin}/art/p${i + 1}.svg`,
          ),
        ),
      ];
    if (id === "lib-music")
      return [
        ...LIB.map((a) => albumContainer(a, id)),
        didlContainer("deep-boxes", id, "Boxes and Bootlegs Collection", "object.container", null),
        didlTrack(LIB[0], 1),
      ];
    if (/^art-\d+$/.test(id))
      return [
        didlContainer(`${id}-alltracks`, id, " [All Tracks]", "object.container", null),
        didlContainer(`${id}-shuffle`, id, " [Shuffle Tracks]", "object.container", null),
        ...LIB.map((a) => albumContainer(a, id)),
      ];
    if (/^art-\d+-(alltracks|shuffle)$/.test(id)) return allTracks();
    const alb = LIB.find((a) => a.id === id);
    if (alb) return Array.from({ length: alb.count }, (_, i) => didlTrack(alb, i + 1));
    return null;
  }
  function cdMetadata(id: string): string | null {
    const deep = DEEP_FOLDERS[id];
    if (deep) return didlContainer(id, deep[0], deep[1], "object.container", null);
    if (id === DEEP.id) return albumContainer(DEEP, "deep-nineties");
    const t = /^(.+)-t(\d+)$/.exec(id);
    const alb = t ? [...LIB, DEEP].find((a) => a.id === t[1]) : undefined;
    if (t && alb && Number(t[2]) >= 1 && Number(t[2]) <= alb.count)
      return didlTrack(alb, Number(t[2]));
    if (id === "lib-music") return didlContainer(id, "0", "Music", "object.container", null);
    if (id === "lib-singles") return didlContainer(id, "0", "Singles", "object.container", null);
    const album = LIB.find((a) => a.id === id);
    if (album) return albumContainer(album, "lib-music");
    const sng = SINGLES.findIndex(([sid]) => sid === id);
    if (sng >= 0) return singles("lib-singles")[sng];
    return null;
  }

  // the second server: its own Amber Nights, searchable, its ids its own
  const LIB2: Album[] = [
    {
      id: "a2-amber",
      title: "Amber Nights",
      artist: "The Mock Artists",
      date: "2011-03-14",
      art: `${origin2}/art/p21.svg`,
      count: 3,
      genres: ["Electronic"],
      track: (n) => ({
        title: `Amber Track ${n}`,
        album: "Amber Nights",
        artist: "The Mock Artists",
        art: `${origin2}/art/p21.svg`,
        duration: 200 + n,
      }),
    },
    {
      id: "a2-velvet",
      title: "Velvet Static",
      artist: "Static Nomads",
      date: "2019-09-09",
      art: `${origin2}/art/p22.svg`,
      count: 4,
      genres: ["Ambient"],
      track: (n) => ({
        title: `Velvet ${n}`,
        album: "Velvet Static",
        artist: "Static Nomads",
        art: `${origin2}/art/p22.svg`,
        duration: 150 + n * 7,
      }),
    },
  ];
  function cd2Children(id: string): string[] | null {
    if (id === "0") return [didlContainer("a2-music", "0", "Music", "object.container", null)];
    if (id === "a2-music") return LIB2.map((a) => albumContainer(a, id));
    const alb = LIB2.find((a) => a.id === id);
    return alb ? Array.from({ length: alb.count }, (_, i) => didlTrack(alb, i + 1)) : null;
  }
  function cd2Metadata(id: string): string | null {
    if (id === "a2-music") return didlContainer(id, "0", "Music", "object.container", null);
    const alb = LIB2.find((a) => a.id === id);
    if (alb) return albumContainer(alb, "a2-music");
    const t = /^(a2-\w+)-t(\d+)$/.exec(id);
    const a = t ? LIB2.find((x) => x.id === t[1]) : undefined;
    return t && a ? didlTrack(a, Number(t[2])) : null;
  }

  const retitle = (didl: string): string =>
    retitled
      ? didl.replace(
          /(<item\b[^>]*>[\s\S]*?<dc:title>)([^<]*)(<\/dc:title>)/g,
          "$1$2 (Remastered)$3",
        )
      : didl;
  const mountIds = (didl: string): string =>
    didl
      .replace(/ id="([^"]+)"/g, (_, id: string) =>
        id === "0" ? ' id="0"' : ` id="${mount}:${id}"`,
      )
      .replace(/ parentID="([^"]+)"/g, (_, id: string) =>
        id === "0" ? ' parentID="0"' : ` parentID="${mount}:${id}"`,
      );
  const usbSession = (): string => ((mount * 0x9e37) & 0xffff).toString(16).padStart(4, "0");
  const usbNo = (): number => mount + 44;
  const usbArt = (didl: string): string =>
    opts.usbArt
      ? didl.replace(
          /(<upnp:albumArtURI[^>]*>)([^<]+)(<\/upnp:albumArtURI>)/g,
          (_, open: string, url: string, close: string) => {
            let k = artKeys.get(url);
            if (k == null) {
              k = artOrigins.length;
              artKeys.set(url, k);
              artOrigins.push(url);
            }
            return `${open}${origin}/album-art-${usbSession()}?id=${usbNo()}:${k}${close}`;
          },
        )
      : didl;
  /** The fake's own id for a drive path: each step picks a child by position. */
  const pathTarget = (path: string): string | null => {
    let node = "0";
    for (const s of path.split("_").slice(1)) {
      const kid = cdChildren(node)?.[Number(s)];
      const id = kid ? / id="([^"]+)"/.exec(kid)?.[1] : undefined;
      if (!id) return null;
      node = id;
    }
    return node;
  };
  /** An Evo-shaped id's path on the current mount, else null. */
  const forgetsPath = (id: string): string | null => {
    const m = /^(\d+):(0(?:_\d+)*)$/.exec(id);
    return m && Number(m[1]) === mount ? m[2] : null;
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  const server2 = opts.secondServer
    ? createServer((req, res) => {
        handle(req, res).catch(() => res.destroy());
      })
    : null;
  let port = 0;

  const flap = (seconds: number): void => {
    flaps++;
    server.closeAllConnections();
    server.close(() => {
      relisten = setTimeout(() => {
        relisten = null;
        if (flapReset) {
          updateId = 1;
          mount += step;
          listed.clear();
          rotated = true;
        }
        if (!stopped) server.listen(port, "127.0.0.1");
      }, seconds * 1000);
    });
  };

  function soap(res: ServerResponse, inner: string): void {
    res.writeHead(200, { "content-type": "text/xml" });
    res.end(envelope(inner));
  }
  function gone(res: ServerResponse): void {
    res.writeHead(500);
    res.end("no such object");
  }

  async function ownControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    cdCalls++;
    if (flapArmed > 0 && body.includes("<u:Browse")) {
      const seconds = flapArmed;
      flapArmed = 0;
      if (flapTorn) {
        flapTorn = false;
        res.writeHead(200, { "content-type": "text/xml" });
        res.write(
          '<?xml version="1.0"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:BrowseResponse',
        );
        setTimeout(() => flap(seconds), 150);
        return;
      }
      flap(seconds);
      return;
    }
    if (body.includes("GetSystemUpdateID"))
      return soap(
        res,
        `<u:GetSystemUpdateIDResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Id>${updateId}</Id></u:GetSystemUpdateIDResponse>`,
      );
    if (body.includes("GetSearchCapabilities"))
      return soap(
        res,
        '<u:GetSearchCapabilitiesResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><SearchCaps></SearchCaps></u:GetSearchCapabilitiesResponse>',
      );
    if (!body.includes("<u:Browse")) {
      res.writeHead(500);
      res.end("not supported");
      return;
    }
    const asked = /<ObjectID>(.*?)<\/ObjectID>/.exec(body)?.[1] ?? "0";
    const flag = /<BrowseFlag>(.*?)<\/BrowseFlag>/.exec(body)?.[1] ?? "BrowseDirectChildren";
    const start = Number(/<StartingIndex>(\d+)<\/StartingIndex>/.exec(body)?.[1] ?? 0);
    const efiTop = `${mount - 1}:0`;
    const efiNode = `<container id="${efiTop}" parentID="0" restricted="1" childCount="0"><dc:title>EFI</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>`;
    if (opts.partitions && asked === efiTop) {
      const meta = flag === "BrowseMetadata";
      return soap(res, browseResponse(didlWrap(meta ? efiNode : ""), meta ? 1 : 0, meta ? 1 : 0));
    }
    if (opts.forgets) {
      const answer = (didl: string, returned: number, total: number): void =>
        soap(res, browseResponse(didl, returned, total));
      const top = `<container id="${mount}:0" parentID="0" restricted="1"><dc:title>Mock Drive</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>`;
      if (asked === "0") {
        if (flag === "BrowseMetadata")
          return answer(
            didlWrap(
              '<container id="0" parentID="-1" restricted="1"><dc:title>root</dc:title><upnp:class>object.container</upnp:class></container>',
            ),
            1,
            1,
          );
        const tops = [...(opts.partitions ? [efiNode] : []), top];
        return answer(didlWrap(tops.slice(start).join("")), tops.length - start, tops.length);
      }
      const path = forgetsPath(asked);
      if (path == null) return gone(res);
      // known only under a folder listed since the mount (the drive's top hangs off the root)
      const parent = path.includes("_") ? path.slice(0, path.lastIndexOf("_")) : null;
      if (parent != null && !listed.has(parent)) return gone(res);
      const target = pathTarget(path);
      if (target == null) return gone(res);
      const at = (p: string): string => `${mount}:${p}`;
      const placed = (part: string, id: string, parentId: string): string =>
        part
          .replace(/ id="[^"]*"/, ` id="${id}"`)
          .replace(/ parentID="[^"]*"/, ` parentID="${parentId}"`);
      if (flag === "BrowseMetadata") {
        if (target === "0") return answer(didlWrap(top), 1, 1);
        const meta = cdMetadata(target);
        if (!meta) return gone(res);
        return answer(
          usbArt(retitle(didlWrap(placed(meta, at(path), parent == null ? "0" : at(parent))))),
          1,
          1,
        );
      }
      const kids = cdChildren(target);
      if (!kids) return gone(res);
      const cold = rotated && !listed.has(path) ? coldMs : 0;
      listed.add(path);
      const parts = kids
        .slice(start, start + 150)
        .map((k, i) => placed(k, at(`${path}_${start + i}`), at(path)));
      const send = (): void =>
        answer(usbArt(retitle(didlWrap(parts.join("")))), parts.length, kids.length);
      if (cold) setTimeout(send, cold);
      else send();
      return;
    }
    // a mount-prefixed id: the current mount answers, any other is gone
    let objectId = asked;
    if (objectId !== "0") {
      const m = /^(\d+):(.*)$/.exec(objectId);
      if (!m || Number(m[1]) !== mount) return gone(res);
      objectId = m[2];
    }
    const meta = flag === "BrowseMetadata" ? cdMetadata(objectId) : null;
    const all = flag === "BrowseMetadata" ? (meta ? [meta] : null) : cdChildren(objectId);
    if (!all) return gone(res);
    const parts = all.slice(start, start + 150);
    let result = usbArt(retitle(mountIds(didlWrap(parts.join("")))));
    const rootListing = opts.partitions && objectId === "0" && flag === "BrowseDirectChildren";
    const efiLeads = rootListing && start === 0;
    if (efiLeads) result = result.replace(/(<DIDL-Lite[^>]*>)/, `$1${efiNode}`);
    return soap(
      res,
      browseResponse(result, parts.length + (efiLeads ? 1 : 0), all.length + (rootListing ? 1 : 0)),
    );
  }

  async function secondControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (body.includes("GetSystemUpdateID"))
      return soap(
        res,
        '<u:GetSystemUpdateIDResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Id>7</Id></u:GetSystemUpdateIDResponse>',
      );
    if (body.includes("GetSearchCapabilities"))
      return soap(
        res,
        '<u:GetSearchCapabilitiesResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><SearchCaps>*</SearchCaps></u:GetSearchCapabilitiesResponse>',
      );
    if (body.includes("<u:Search")) {
      // scope-aware, classes generalized in the answer (Asset's shape)
      const q = (/contains &quot;(.*?)&quot;/.exec(body)?.[1] ?? "").toLowerCase();
      const scope = /derivedfrom &quot;(.*?)&quot;/.exec(body)?.[1] ?? "";
      const parts: string[] = [];
      if (scope.includes("container.album")) {
        for (const a of LIB2)
          if (a.title.toLowerCase().includes(q))
            parts.push(
              didlContainer(
                a.id,
                "a2-music",
                a.title,
                "object.container.album",
                a.art,
                a.artist,
                a.date,
                a.genres,
              ),
            );
      } else if (scope.includes("item.audioItem")) {
        for (const a of LIB2)
          for (let n = 1; n <= a.count; n++)
            if (a.track(n).title.toLowerCase().includes(q)) parts.push(didlTrack(a, n));
      }
      return soap(
        res,
        `<u:SearchResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Result>${xmlEsc(didlWrap(parts.join("")))}</Result><NumberReturned>${parts.length}</NumberReturned><TotalMatches>${parts.length}</TotalMatches><UpdateID>1</UpdateID></u:SearchResponse>`,
      );
    }
    const objectId = /<ObjectID>(.*?)<\/ObjectID>/.exec(body)?.[1] ?? "0";
    const flag = /<BrowseFlag>(.*?)<\/BrowseFlag>/.exec(body)?.[1] ?? "BrowseDirectChildren";
    const meta = flag === "BrowseMetadata" ? cd2Metadata(objectId) : null;
    const all = flag === "BrowseMetadata" ? (meta ? [meta] : null) : cd2Children(objectId);
    if (!all) return gone(res);
    return soap(res, browseResponse(didlWrap(all.join("")), all.length, all.length));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", "http://fake");
    if (u.pathname === "/smoip/system/upnp") {
      upnpListings++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            devices: [
              {
                model: "EVO150",
                name: "Mock Evo",
                manufacturer: "Cambridge Audio",
                udn: OWN,
                description_url: `${origin}/description.xml`,
              },
              ...(opts.secondServer
                ? [
                    {
                      model: "Asset UPnP",
                      name: "Mock Asset",
                      manufacturer: "Illustrate",
                      udn: "mock-udn-2",
                      description_url: `${origin2}/description2.xml`,
                    },
                  ]
                : []),
            ],
          },
        }),
      );
      return;
    }
    if (u.pathname === "/description.xml" || u.pathname === "/description2.xml") {
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(
        u.pathname === "/description.xml"
          ? description("Mock Evo", OWN, "/upnp/control")
          : description("Mock Asset", "mock-udn-2", "/upnp2/control"),
      );
      return;
    }
    if (u.pathname === "/upnp/control" && req.method === "POST") return ownControl(req, res);
    if (u.pathname === "/upnp2/control" && req.method === "POST") return secondControl(req, res);
    if (u.pathname === "/smoip/queue/add") {
      // the id the DIDL names must be an object on the drive as it now stands
      const id = / id="([^"]+)"/.exec(u.searchParams.get("didl") ?? "")?.[1] ?? "";
      const path = opts.forgets ? forgetsPath(id) : null;
      const target = opts.forgets
        ? path != null
          ? pathTarget(path)
          : null
        : id.replace(/^\d+:/, "");
      const known = target != null && cdMetadata(target) != null;
      res.writeHead(known ? 200 : 400, { "content-type": "application/json" });
      res.end(known ? "{}" : '{"error":"unknown didl target"}');
      return;
    }
    const pic = /^\/album-art-([0-9a-f]{4})$/.exec(u.pathname);
    if (pic && opts.usbArt) {
      // this wake's address serves the picture it names, an older wake's is a 404
      const m = /^(\d+):(\d+)$/.exec(u.searchParams.get("id") ?? "");
      const ok =
        m && pic[1] === usbSession() && Number(m[1]) === usbNo() && artOrigins[Number(m[2])];
      res.writeHead(ok ? 200 : 404, ok ? { "content-type": "image/svg+xml" } : {});
      res.end(ok ? SVG : undefined);
      return;
    }
    if (/^\/art\/[pq]\d+\.svg$/.test(u.pathname)) {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end(SVG);
      return;
    }
    res.writeHead(404);
    res.end();
  }

  const listen = (s: Server): Promise<number> =>
    new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
  port = await listen(server);
  origin = `http://127.0.0.1:${port}`;
  origin2 = server2 ? `http://127.0.0.1:${await listen(server2)}` : origin;

  return {
    host: `127.0.0.1:${port}`,
    origin,
    origin2,
    stats: () => ({ updateId, mount, cdCalls, upnpListings, flaps, listed: [...listed] }),
    resetCounters: () => {
      cdCalls = 0;
      upnpListings = 0;
    },
    rotate: ({ holdCounter = false, retitle: newTitles = false } = {}) => {
      mount += step;
      listed.clear();
      rotated = true;
      if (!holdCounter) updateId++;
      if (newTitles) retitled = true;
    },
    armFlap: (seconds, { reset, torn = false }) => {
      flapArmed = seconds;
      flapReset = reset;
      flapTorn = torn;
    },
    stop: async () => {
      stopped = true;
      if (relisten) clearTimeout(relisten);
      for (const s of [server, server2])
        if (s) {
          s.closeAllConnections();
          if (s.listening) await new Promise<void>((r) => s.close(() => r()));
        }
    },
  };
}

// ------------------------------------------------------------------------------ S83

describe("resolveContent and lookupMediaInfo: a Browse-built index is confirmed before its answer is trusted", () => {
  let evo: FakeEvo;
  let m: Media;
  let own: MediaServerInfo | undefined;
  beforeAll(async () => {
    evo = await startFakeEvo();
    m = await freshMedia();
  });
  afterAll(() => evo.stop());

  it("lists the streamer's own server as Browse-only", async () => {
    own = (await m.refreshServers(evo.host)).find((s) => s.udn === OWN);
    expect(own).toBeDefined();
    expect(own?.searchable).toBe(false);
  });

  it("walks it into a Browse index whose ids carry the mount", async () => {
    await m.rebuild(evo.host, own as MediaServerInfo);
    expect(m.pools().find((p) => p.udn === OWN)?.profile?.strategy).toBe("browse");
    expect((await m.resolveContent(evo.host, ref))?.objectId).toBe("26:alb-1-t3");
  });

  it("sees the counter move after a rotation and answers the new id, never the stale one", async () => {
    evo.rotate();
    expect((await m.resolveContent(evo.host, ref))?.objectId).toBe("27:alb-1-t3");
  });

  it("lands Open in Library's lookup on the fresh container", async () => {
    expect((await m.lookupMediaInfo(evo.host, amber, "act"))?.node.id).toBe("27:alb-1");
  });

  let amberAfterHold: Awaited<ReturnType<Media["lookupMediaInfo"]>> = null;
  it("catches a counter that lies by the id in hand, in the resolver and in the lookup", async () => {
    evo.rotate({ holdCounter: true });
    expect((await m.resolveContent(evo.host, ref))?.objectId).toBe("28:alb-1-t3");
    amberAfterHold = await m.lookupMediaInfo(evo.host, amber, "act");
    expect(amberAfterHold?.node.id).toBe("28:alb-1");
  });

  it("knows the folder path: an album's ends with its own folder, a track's is its album's, and an album listed twice keeps the path of the copy the index credits", async () => {
    const deep = await m.lookupMediaInfo(
      evo.host,
      { kind: "album", title: "Deep Album", artist: "The Mock Artists" },
      "act",
    );
    const deepTrack = await m.lookupMediaInfo(
      evo.host,
      { kind: "track", title: "Deep Track 1", artist: "The Mock Artists", album: "Deep Album" },
      "act",
    );
    expect(deep?.node.titlePath).toEqual([
      "Music",
      "Boxes and Bootlegs Collection",
      "Rock and Alternative",
      "The Nineties Reissues",
      "Deep Album",
    ]);
    expect(deepTrack?.node.titlePath).toEqual(deep?.node.titlePath);
    const amberPath = amberAfterHold?.node.titlePath ?? [];
    expect(amberPath.at(-1)).toBe("Amber Nights");
    expect(amberPath.length).toBeGreaterThanOrEqual(2);
  });
});

// ------------------------------------------------------------------------------ S91

describe("revalidate through the device's lane: a silence on the wire is not a rotation", () => {
  let evo: FakeEvo;
  let m: Media;
  let own: MediaServerInfo | undefined;
  let asset: MediaServerInfo | undefined;
  beforeAll(async () => {
    evo = await startFakeEvo({ secondServer: true });
    // the cap, shortened as the suite shortens it, so a silence opens and closes in seconds
    vi.stubEnv("TASTYTUNES_DEVICE_COOL_MS", "8000");
    m = await freshMedia();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await evo.stop();
  });

  it("lists the mock's own server in the USB server's shape (on the device, Browse-only) and the second server, on its own origin, not", async () => {
    const servers = await m.refreshServers(evo.host);
    own = servers.find((s) => s.udn === OWN);
    asset = servers.find((s) => s.udn === "mock-udn-2");
    expect(own?.isStreamer).toBe(true);
    expect(own?.searchable).toBe(false);
    expect(asset?.searchable).toBe(true);
  });

  it("answers three listings within the memo with none on the wire", async () => {
    evo.resetCounters();
    await Promise.all([
      m.refreshServers(evo.host),
      m.refreshServers(evo.host),
      m.refreshServers(evo.host),
    ]);
    expect(evo.stats().upnpListings).toBe(0);
  });

  it("answers from the stick's index with the mount's ids while the device answers", async () => {
    await m.rebuild(evo.host, own as MediaServerInfo);
    await m.rebuild(evo.host, asset as MediaServerInfo);
    expect((await m.resolveContent(evo.host, ref))?.objectId).toBe("26:alb-1-t3");
  });

  it("lands the same album on two servers on the one the art URL names, and keeps index order with no art", async () => {
    const plain = await m.lookupMediaInfo(evo.host, amber, "act");
    const viaAsset = await m.lookupMediaInfo(
      evo.host,
      { ...amber, artUrl: `${evo.origin2}/art/p21.svg` },
      "act",
    );
    const viaOwn = await m.lookupMediaInfo(
      evo.host,
      { ...amber, artUrl: `${evo.origin}/art/p1.svg` },
      "act",
    );
    expect(viaAsset?.node.id).toBe("a2-amber");
    expect(viaOwn?.node.id).toBe("26:alb-1");
    expect(plain).not.toBeNull();
  });

  it(
    "holds the probe in flight through a silence and sends it again once the canary hears the device",
    { timeout: 20_000 },
    async () => {
      evo.resetCounters();
      evo.armFlap(3, { reset: false });
      const t = Date.now();
      const stale = await m.revalidate(evo.host, OWN, "26:alb-1-t3");
      const waited = Date.now() - t;
      expect(stale).toBe(false);
      expect(waited).toBeGreaterThan(2500);
      expect(waited).toBeLessThan(12000);
      expect(m.deviceCooling()).toBe(false);
    },
  );

  it("keeps the index it had through the silence", () => {
    expect(m.pools().find((p) => p.udn === OWN)?.tracks.length ?? 0).toBeGreaterThan(0);
  });

  it("sends nothing to the device while it is down: the counter read and the probe before, the canary and the retried probe after", () => {
    const st = evo.stats();
    expect(st.flaps).toBe(1);
    expect(st.updateId).toBe(3);
    expect(st.cdCalls).toBeGreaterThanOrEqual(3);
    expect(st.cdCalls).toBeLessThanOrEqual(6);
  });

  it(
    "treats a body that dies partway as the device's silence: the probe waits for the canary and goes again",
    { timeout: 20_000 },
    async () => {
      evo.armFlap(3, { reset: false, torn: true });
      const t = Date.now();
      const stale = await m.revalidate(evo.host, OWN, "26:alb-1-t3");
      const waited = Date.now() - t;
      expect(stale).toBe(false);
      expect(waited).toBeGreaterThan(2500);
      expect(waited).toBeLessThan(12000);
      expect(m.deviceCooling()).toBe(false);
      expect(evo.stats().flaps).toBe(2);
    },
  );

  it(
    "heals the asked-for answer after a restart with re-minted ids",
    { timeout: 20_000 },
    async () => {
      evo.armFlap(3, { reset: true });
      expect((await m.resolveContent(evo.host, ref))?.objectId).toBe("27:alb-1-t3");
    },
  );

  it("marks the stick's index stale for the card on a moved counter alone and walks nothing", async () => {
    evo.rotate();
    evo.resetCounters();
    m.ensureFresh(evo.host, [own as MediaServerInfo]);
    await sleep(1000);
    expect(m.status().find((x) => x.udn === OWN)?.stale).toBe(true);
    expect(evo.stats().cdCalls).toBe(1);
  });
});

// ----------------------------------------------------------------------------- S102

describe("revalidate's heal: the USB ids move across a standby, and the index follows without a walk", () => {
  let m: Media;
  const logs: string[] = [];
  const since = (n: number): string[] => logs.slice(n);
  /** Every status the index announces, as the waiting flag on the stick's. */
  const waits: boolean[] = [];

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    m = await freshMedia();
    // a playlist whose first track is a single, in a folder no album check reaches: the heal
    // ahead's likely next play (its id from mount 26, as saved)
    writeFileSync(
      join(paths.userData, "playlists.json"),
      JSON.stringify([
        {
          id: "p102",
          name: "Singles",
          createdAt: 1,
          updatedAt: 1,
          items: [
            {
              title: "Single",
              artist: null,
              album: null,
              artUrl: null,
              serverUdn: OWN,
              serverName: "Mock Evo",
              objectId: "26:0_2_0",
              durationSecs: 200,
            },
          ],
        },
      ]),
    );
    m.init((statuses) => waits.push(statuses.find((x) => x.udn === OWN)?.waiting === true));
  });
  afterAll(() => {
    vi.mocked(console.log).mockRestore();
  });

  describe("on a drive whose mount moves", () => {
    let evo: FakeEvo;
    let own: MediaServerInfo;
    let before: string | undefined;
    let walkCalls = 0;
    beforeAll(async () => {
      evo = await startFakeEvo();
      own = (await m.refreshServers(evo.host)).find((s) => s.udn === OWN) as MediaServerInfo;
      await m.rebuild(evo.host, own);
      before = (await m.resolveContent(evo.host, ref))?.objectId;
      walkCalls = evo.stats().cdCalls;
    });
    afterAll(() => evo.stop());

    it("heals by content after a standby in a handful of requests and answers the new id, every stored id on the new mount", async () => {
      evo.rotate();
      evo.resetCounters();
      const healed = await m.resolveContent(evo.host, ref);
      const st = evo.stats();
      const tracks = m.pools().find((p) => p.udn === OWN)?.tracks ?? [];
      expect(before).toBe("26:alb-1-t3");
      expect(healed?.objectId).toBe("27:alb-1-t3");
      expect(st.cdCalls).toBeLessThanOrEqual(20);
      expect(st.cdCalls).toBeLessThan(walkCalls);
      expect(tracks.length).toBeGreaterThan(0);
      expect(tracks.every((t) => t.id.startsWith("27:"))).toBe(true);
    });

    it("never marks the status waiting for a heal that quick", () => {
      expect(waits.some(Boolean)).toBe(false);
    });

    it("leaves the Library's card offering the re-index for files added since", async () => {
      m.ensureFresh(evo.host, [own]);
      await sleep(800);
      expect(m.status().find((x) => x.udn === OWN)?.stale).toBe(true);
    });

    it("misses the check and walks when the drive's contents changed under the same paths", async () => {
      evo.rotate({ retitle: true });
      evo.resetCounters();
      await m.resolveContent(evo.host, ref);
      const retitled = (m.pools().find((p) => p.udn === OWN)?.tracks ?? []).filter((t) =>
        / \(Remastered\)$/.test(t.title),
      ).length;
      expect(evo.stats().cdCalls).toBeGreaterThan(20);
      expect(retitled).toBeGreaterThan(0);
    });
  });

  describe("on a drive with an EFI partition listed first", () => {
    let evo: FakeEvo;
    let before: string | undefined;
    let walkCalls = 0;
    beforeAll(async () => {
      evo = await startFakeEvo({ partitions: true });
      const own = (await m.refreshServers(evo.host)).find((s) => s.udn === OWN);
      await m.rebuild(evo.host, own as MediaServerInfo);
      before = (await m.resolveContent(evo.host, ref))?.objectId;
      walkCalls = evo.stats().cdCalls;
    });
    afterAll(() => evo.stop());

    it("passes over the EFI partition and lands on the music in a handful of requests, and says so", async () => {
      evo.rotate();
      evo.resetCounters();
      const from = logs.length;
      const healed = await m.resolveContent(evo.host, ref);
      const st = evo.stats();
      const said =
        since(from).find((l) => /no walk/.test(l)) ??
        since(from).find((l) => /no heal/.test(l)) ??
        "";
      expect(before).toBe("26:alb-1-t3");
      expect(healed?.objectId).toBe("28:alb-1-t3");
      expect(st.cdCalls).toBeLessThanOrEqual(24);
      expect(st.cdCalls).toBeLessThan(walkCalls);
      expect(said).toMatch(/passed over mount 27/);
    });
  });

  describe("on a drive that forgets its folders in standby", () => {
    let evo: FakeEvo;
    let before = "";
    let walkCalls = 0;
    const moved = (mount: number): string => before.replace(/^26:/, `${mount}:`);
    beforeAll(async () => {
      evo = await startFakeEvo({ partitions: true, forgets: true, coldMs: 150 });
      const own = (await m.refreshServers(evo.host)).find((s) => s.udn === OWN);
      await m.rebuild(evo.host, own as MediaServerInfo);
      before = (await m.resolveContent(evo.host, ref))?.objectId ?? "";
      walkCalls = evo.stats().cdCalls;
    });
    afterAll(() => evo.stop());

    let healed: string | undefined;
    let healLogs: string[] = [];
    let healStats: FakeStats | undefined;
    it(
      "marks the status waiting once a heal on cold folders has waited a second, and clears it when the heal ends",
      { timeout: 20_000 },
      async () => {
        evo.rotate();
        evo.resetCounters();
        waits.length = 0;
        const t = Date.now();
        const from = logs.length;
        healed = (await m.resolveContent(evo.host, ref))?.objectId;
        const ms = Date.now() - t;
        healLogs = since(from);
        healStats = evo.stats();
        expect(ms).toBeGreaterThan(1200);
        expect(waits).toContain(true);
        expect(waits.at(-1)).toBe(false);
        expect(waits.indexOf(true)).toBeLessThan(waits.lastIndexOf(false));
      },
    );

    it("lists the folders above its checks and lands without a walk", () => {
      const said =
        healLogs.find((l) => /no walk/.test(l)) ?? healLogs.find((l) => /no heal/.test(l)) ?? "";
      expect(before).toMatch(/^26:0(_\d+)+$/);
      expect(healed).toBe(moved(28));
      expect(healStats?.cdCalls).toBeLessThan(walkCalls);
      expect(said).toMatch(/no walk/);
      expect(said).toMatch(/passed over mount 27/);
      expect(
        healLogs.some((l) => /answers once the \d+ folders above it are listed again/.test(l)),
      ).toBe(true);
    });

    it("still queues a track in a folder nobody has listed since the standby", async () => {
      const listed = new Set(healStats?.listed);
      const cold = (m.pools().find((p) => p.udn === OWN)?.tracks ?? []).find(
        (t) => t.parentId && !listed.has(t.parentId.replace(/^\d+:/, "")),
      );
      expect(cold).toBeDefined();
      await expect(m.queueAdd(evo.host, OWN, cold?.id ?? "", "APPEND")).resolves.toBeUndefined();
    });

    it("keeps an id from the old mount gone at the cost of one listing", async () => {
      evo.resetCounters();
      expect(await m.browseMetadataNode(evo.host, OWN, before)).toBeNull();
      expect(evo.stats().cdCalls).toBe(2);
    });

    it("ahead of time with the counter unmoved, reads the listing's capability and the counter and browses nothing", async () => {
      evo.resetCounters();
      await m.healAhead(evo.host);
      const calls = evo.stats().cdCalls;
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(calls).toBeLessThanOrEqual(2);
    });

    let aheadLogs: string[] = [];
    let act: string | undefined;
    it(
      "heals ahead of time a standby later, listing few folders, the likely play's among them, which then queues with no folder left to list",
      { timeout: 20_000 },
      async () => {
        evo.rotate();
        evo.resetCounters();
        const from = logs.length;
        await m.healAhead(evo.host);
        const listed = evo.stats().listed;
        act = (await m.resolveContent(evo.host, ref))?.objectId;
        const beforeQueue = logs.length;
        await m.queueAdd(evo.host, OWN, "30:0_2_0", "APPEND");
        const listings = since(beforeQueue).filter((l) =>
          /folders above it are listed again/.test(l),
        ).length;
        aheadLogs = since(from);
        expect(listed.length).toBeLessThanOrEqual(12);
        expect(listed).toContain("0_2");
        expect(listings).toBe(0);
      },
    );

    it("leaves the act that follows the heal ahead the new id with no heal or walk of its own", () => {
      expect(act).toBe(moved(30));
      expect(aheadLogs.filter((l) => /confirmed by content, no walk/.test(l))).toHaveLength(1);
      expect(aheadLogs.some((l) => /healing ahead of time/.test(l))).toBe(true);
      expect(aheadLogs.some((l) => /rebuilding/.test(l))).toBe(false);
    });

    it(
      "makes an act that arrives while the heal ahead runs wait for it and ask again, one heal between them",
      { timeout: 20_000 },
      async () => {
        evo.rotate();
        const from = logs.length;
        const ahead = m.healAhead(evo.host);
        await sleep(300);
        const acted = await m.resolveContent(evo.host, ref);
        await ahead;
        expect(acted?.objectId).toBe(moved(32));
        expect(since(from).filter((l) => /confirmed by content, no walk/.test(l))).toHaveLength(1);
      },
    );

    it(
      "stops the heal ahead at its next check when the streamer goes back to sleep, the index where it was",
      { timeout: 20_000 },
      async () => {
        evo.rotate();
        const from = logs.length;
        const ahead = m.healAhead(evo.host);
        await sleep(500);
        m.cancelHealAhead();
        await ahead;
        const mount = (m.pools().find((p) => p.udn === OWN)?.tracks ?? [])[0]?.id?.split(":")[0];
        expect(
          since(from).some((l) => /no heal, the streamer went to sleep|went to sleep/.test(l)),
        ).toBe(true);
        expect(mount).toBe("32");
      },
    );
  });

  describe("when a wake re-mints the drive's pictures", () => {
    let evo: FakeEvo;
    const pictures = (): string[] => {
      const p = m.pools().find((x) => x.udn === OWN);
      return [
        ...new Set(
          [...(p?.albums ?? []), ...(p?.tracks ?? [])]
            .map((n) => n.artUrl)
            .filter((u): u is string => u != null && u !== ""),
        ),
      ];
    };
    const answering = async (urls: string[]): Promise<number> =>
      (
        await Promise.all(
          urls.map((u) =>
            fetch(u).then(
              (r) => r.status,
              () => 0,
            ),
          ),
        )
      ).filter((s) => s === 200).length;
    beforeAll(async () => {
      evo = await startFakeEvo({ partitions: true, forgets: true, coldMs: 20, usbArt: true });
      const own = (await m.refreshServers(evo.host)).find((s) => s.udn === OWN);
      await m.rebuild(evo.host, own as MediaServerInfo);
    });
    afterAll(() => evo.stop());

    it("moves every picture in the index with the ids, no walk", { timeout: 20_000 }, async () => {
      const before = pictures();
      const fresh = await answering(before);
      evo.rotate();
      const stale = await answering(before);
      const from = logs.length;
      const healed = await m.resolveContent(evo.host, ref);
      const after = pictures();
      const live = await answering(after);
      expect(before.length).toBeGreaterThanOrEqual(2);
      expect(fresh).toBe(before.length);
      expect(stale).toBe(0);
      expect(healed?.objectId).toBeDefined();
      expect(after).toHaveLength(before.length);
      expect(live).toBe(after.length);
      expect(
        since(from).some((l) => /pictures with them; confirmed by content, no walk/.test(l)),
      ).toBe(true);
    });
  });
});
