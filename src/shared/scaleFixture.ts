// THE SCALE FIXTURE (0.13.0 round 2; the 0.11 re-score: "nothing proves the app above 5,000
// tracks"). A library of any size in the media index's own shape, made the same way every time:
// ten tracks to an album, four albums to an artist, years across six decades, the genres round
// ten, two formats, and one album in a hundred held twice (the same title and artist, another
// picture, 24/96), so the copy rules run at size too. The mock streamer's MOCK_LIB_SCALE serves
// the same library over UPnP for the end-to-end check. Tests only: no entry imports it.

import type { ListeningPlayEvent } from "./model/listening";
import type { MediaIndexPools, MediaNode } from "./model/media";

const GENRES = [
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
const SERVER = "uuid:scale";

/** One server's pools holding `tracks` tracks. */
export function scaleLibrary(tracks: number): MediaIndexPools[] {
  const albums: MediaNode[] = [];
  const all: MediaNode[] = [];
  const artists = new Map<string, MediaNode>();
  const count = Math.ceil(tracks / 10);
  for (let i = 0; i < count; i++) {
    const twin = i % 100 === 99;
    const k = twin ? i - 1 : i;
    const title = `Scale Album ${k + 1}`;
    const artist = `Scale Artist ${Math.floor(k / 4) + 1}`;
    const artUrl = `http://scale.local/art/p${((twin ? i + 7 : i) % 24) + 1}.jpg`;
    const year = String(1960 + (k % 60));
    const format = twin
      ? { codec: "FLAC", bits: 24, rate: 96000 }
      : { codec: "FLAC", bits: 16, rate: 44100 };
    const album: MediaNode = {
      id: `scl-${i + 1}`,
      parentId: "music",
      title,
      upnpClass: "object.container.album.musicAlbum",
      isContainer: true,
      artUrl,
      artist,
      album: null,
      year,
      trackNumber: null,
      durationSecs: null,
      genre: [GENRES[k % 10]],
      serverUdn: SERVER,
      serverName: "Scale",
    };
    albums.push(album);
    if (!artists.has(artist))
      artists.set(artist, {
        ...album,
        id: `art-${artists.size + 1}`,
        title: artist,
        upnpClass: "object.container.person.musicArtist",
      });
    const n = Math.min(10, tracks - i * 10);
    for (let t = 1; t <= n; t++)
      all.push({
        id: `scl-${i + 1}-t${t}`,
        parentId: album.id,
        title: `Scale ${k + 1}.${t}`,
        upnpClass: "object.item.audioItem.musicTrack",
        isContainer: false,
        artUrl,
        artist,
        album: title,
        year,
        trackNumber: t,
        durationSecs: 120 + ((k * 7 + t * 13) % 300),
        format,
        genre: [GENRES[k % 10]],
        serverUdn: SERVER,
        serverName: "Scale",
      });
  }
  return [
    { udn: SERVER, serverName: "Scale", albums, artists: [...artists.values()], tracks: all },
  ];
}

/** A listening record of `plays` library plays over the fixture's tracks, a play every ten
 *  minutes up to `now`, each carrying its copy's facts as a play since 0.13.0 does. */
export function scaleRecord(
  pools: MediaIndexPools[],
  plays: number,
  now: number,
): ListeningPlayEvent[] {
  const tracks = pools.flatMap((g) => g.tracks);
  const out: ListeningPlayEvent[] = [];
  for (let i = 0; i < plays; i++) {
    // a few tracks played often, most once or never
    const t = tracks[(i * i * 7 + i * 31) % tracks.length];
    out.push({
      v: 1,
      at: now - (plays - i) * 600_000,
      tzOffsetMin: 0,
      kind: "play",
      title: t.title,
      artist: t.artist,
      album: t.album,
      playedSeconds: t.durationSecs ?? 200,
      duration: t.durationSecs,
      codec: t.format?.codec ?? null,
      sampleRate: t.format?.rate ?? null,
      bitDepth: t.format?.bits ?? null,
      lossless: true,
      source: "Media Player",
      sourceId: "MEDIA_PLAYER",
      artUrl: t.artUrl,
      artHost: "scale.local",
    });
  }
  return out;
}
