// THE MEDIA SERVER'S SHAPES (0.15.0, his A on the decision page "Hygiene Pass Decisions"): how a
// UPnP media server answers, as the servers on the live network answer, in one home for the app
// repo's two servers that play one: the demo (demoStreamer, demo/demoLibrary) and the unit tests'
// fake streamer (media/__fixtures__/fakeStreamer, the server CI's tests run against). Each fork
// keeps its own library and its own knobs; the wire shapes are these, so a live truth lands here
// once and both serve it. The harness mock (ops dev/mock-streamer.mjs) keeps its own copy.

export const xmlEsc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A res duration, "0:MM:SS.000". */
export const durFmt = (secs: number): string =>
  `0:${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}.000`;

export const didlWrap = (inner: string): string =>
  `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${inner}</DIDL-Lite>`;

const didlArt = (art: string | null | undefined): string =>
  art ? `<upnp:albumArtURI>${art}</upnp:albumArtURI>` : "";
const didlGenres = (genres: readonly string[] | undefined): string =>
  (genres ?? []).map((g) => `<upnp:genre>${xmlEsc(g)}</upnp:genre>`).join("");

export const didlContainer = (
  id: string,
  parent: string,
  title: string,
  cls: string,
  art: string | null,
  artist?: string,
  date?: string,
  genres?: readonly string[],
): string =>
  `<container id="${id}" parentID="${parent}" restricted="true"><upnp:class>${cls}</upnp:class><dc:title>${xmlEsc(title)}</dc:title>${didlArt(art)}${artist ? `<upnp:artist>${xmlEsc(artist)}</upnp:artist>` : ""}${date ? `<dc:date>${date}</dc:date>` : ""}${didlGenres(genres)}</container>`;

/** Who a track credits. */
export interface Credits {
  artist: string;
  albumArtist?: string;
  composer?: string;
}

/** Asset's artist block for a track: with an album artist, three upnp:artist elements (the
 *  AlbumArtist role, the performers, the Composer role) and a dc:creator repeating the
 *  performers; without, one plain element (and the Composer role). */
export const didlArtists = (c: Credits): string => {
  const composer = c.composer
    ? `<upnp:artist role="Composer">${xmlEsc(c.composer)}</upnp:artist>`
    : "";
  return c.albumArtist
    ? `<dc:creator>${xmlEsc(c.artist)}</dc:creator><upnp:artist role="AlbumArtist">${xmlEsc(c.albumArtist)}</upnp:artist><upnp:artist>${xmlEsc(c.artist)}</upnp:artist>${composer}`
    : `<upnp:artist>${xmlEsc(c.artist)}</upnp:artist>${composer}`;
};

/** A FLAC 16/44.1 res with Asset's DLNA attributes. */
export const flacRes = (secs: number, url: string): string =>
  `<res duration="${durFmt(secs)}" size="${secs * 100000}" bitrate="176400" bitsPerSample="16" sampleFrequency="44100" nrAudioChannels="2" protocolInfo="http-get:*:audio/x-flac:DLNA.ORG_PN=FLAC;DLNA.ORG_OP=01">${url}</res>`;

/** One album track: its title, artists, album, genres, number (and disc), art and res. */
export const didlAlbumTrack = (
  id: string,
  parent: string,
  t: Credits & {
    title: string;
    album: string;
    trackNo: number | string;
    disc?: { n: number | string; count: number | string };
    art: string | null;
  },
  genres: readonly string[] | undefined,
  res: string,
): string =>
  `<item id="${id}" parentID="${parent}" restricted="true"><dc:title>${xmlEsc(t.title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>${didlArtists(t)}<upnp:album>${xmlEsc(t.album)}</upnp:album>${didlGenres(genres)}<upnp:originalTrackNumber>${String(t.trackNo)}</upnp:originalTrackNumber>${t.disc ? `<upnp:originalDiscNumber>${String(t.disc.n)}</upnp:originalDiscNumber><upnp:originalDiscCount>${String(t.disc.count)}</upnp:originalDiscCount>` : ""}${didlArt(t.art)}${res}</item>`;

/** A loose track (a single, no album): a bare res whose protocolInfo says nothing. */
export const didlLooseTrack = (
  id: string,
  parent: string,
  title: string,
  artist: string,
  art: string,
): string =>
  `<item id="${id}" parentID="${parent}" restricted="true"><dc:title>${xmlEsc(title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><upnp:artist>${xmlEsc(artist)}</upnp:artist>${didlArt(art)}<res duration="0:03:00.000" protocolInfo="*:*:*:*">file:///tmp/usm/1/singles/${id}.flac</res></item>`;

/** What Asset answers for an id it no longer has (his library, 2026-10-28): HTTP 200 and this
 *  for metadata, an empty listing for children. */
export const ASSET_BLANK =
  '<container id="-1" parentID="-1" restricted="0" searchable="1"><dc:title></dc:title><dc:creator> </dc:creator><upnp:genre>Unknown</upnp:genre><upnp:class>object.container</upnp:class></container>';

export const soapEnvelope = (inner: string): string => `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`;

const CD = 'xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"';

/** The ContentDirectory's answers, each a SOAP body's inner part (soapEnvelope wraps it). */
export const cd = {
  searchCaps: (caps: string): string =>
    `<u:GetSearchCapabilitiesResponse ${CD}><SearchCaps>${caps}</SearchCaps></u:GetSearchCapabilitiesResponse>`,
  sortCaps: (caps: string): string =>
    `<u:GetSortCapabilitiesResponse ${CD}><SortCaps>${caps}</SortCaps></u:GetSortCapabilitiesResponse>`,
  systemUpdateId: (id: number): string =>
    `<u:GetSystemUpdateIDResponse ${CD}><Id>${id}</Id></u:GetSystemUpdateIDResponse>`,
  /** A Browse's page: `didl` is the whole DIDL-Lite document, escaped into Result here. */
  browse: (didl: string, returned: number, total: number, updateId: number): string =>
    `<u:BrowseResponse ${CD}><Result>${xmlEsc(didl)}</Result><NumberReturned>${returned}</NumberReturned><TotalMatches>${total}</TotalMatches><UpdateID>${updateId}</UpdateID></u:BrowseResponse>`,
  search: (didl: string, returned: number, total: number, updateId: number): string =>
    `<u:SearchResponse ${CD}><Result>${xmlEsc(didl)}</Result><NumberReturned>${returned}</NumberReturned><TotalMatches>${total}</TotalMatches><UpdateID>${updateId}</UpdateID></u:SearchResponse>`,
};

/** A device description naming one ContentDirectory (eventing and SCPD paths when given). */
export const deviceDescription = (d: {
  deviceType: "MediaRenderer" | "MediaServer";
  name: string;
  manufacturer: string;
  udn: string;
  /** The control path's directory, "/upnp" for /upnp/control. */
  base: string;
  eventing?: boolean;
}): string => `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:${d.deviceType}:1</deviceType>
    <friendlyName>${d.name}</friendlyName>
    <manufacturer>${d.manufacturer}</manufacturer>
    <UDN>uuid:${d.udn}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <controlURL>${d.base}/control</controlURL>${
          d.eventing
            ? `
        <eventSubURL>${d.base}/event</eventSubURL>
        <SCPDURL>${d.base}/scpd.xml</SCPDURL>`
            : ""
        }
      </service>
    </serviceList>
  </device>
</root>`;
