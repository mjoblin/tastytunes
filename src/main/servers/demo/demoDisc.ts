// The demo's disc (0.10.0, GitHub issue #1): the CD source with a fictional disc in, so "Try
// without a streamer" shows what a CD owner sees. The shapes are the Evo CD owner's readouts
// (2026-09-26), mirrored from dev/mock-streamer.mjs's MOCK_SCENE=cd: stopped, play_state is
// titled by the disc's table of contents beside the album, the artist and a Cover Art
// Archive-shaped picture naming the release, with no queue fields; playing, now_playing's
// line1 is the track, line2 the artist, line3 the album, and the place is queue {length,
// position} and a "3/10" context. play_state while a disc plays was not in the readouts: the
// track's title and length, as the mock guesses. The release is fictional, so the demo
// streamer answers the app's release lookup itself (/ws/2/release/<id>, see discTracks).
import type { Dict } from "./demoShared";

export const DISC = {
  release: "7a1de0a7-0d15-4c0d-8e11-5eaf0a7e0d15",
  album: "Tidewater",
  artist: "The Harbour Quartet",
  tracks: [
    ["Low Tide", 214],
    ["Salt on the Window", 187],
    ["The Lamplighter", 262],
    ["Ferry at Six", 198],
    ["Gulls", 141],
    ["A Long Way Round", 305],
    ["Breakwater", 233],
    ["Harbour Lights", 276],
    ["Mooring", 199],
    ["Last Boat Home", 452],
  ] as Array<[string, number]>,
};

export const DISC_ART_PATH = `/coverart/release/${DISC.release}/front-500.jpg`;
const STREAM_ID = "dEmOdIsCsTrEaMiD000000000000-";

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const toc = (): string =>
  `Tracks: ${DISC.tracks.length} Length: ${clock(DISC.tracks.reduce((t, [, s]) => t + s, 0))}`;

/** The disc stopped: the owner's play_state, and a now_playing that holds the place at 1. */
export function discStopped(host: string): { playState: Dict; nowPlaying: Dict } {
  const art = `${host}${DISC_ART_PATH}`;
  return {
    playState: {
      state: "stop",
      position: 0,
      presettable: true,
      mode_repeat: "off",
      mode_shuffle: "off",
      metadata: {
        class: "md.track.cd",
        source: "CD",
        name: "CD",
        album: DISC.album,
        artist: DISC.artist,
        title: toc(),
        art_url: art,
        mqa: "none",
        signal: false,
        stream_id: STREAM_ID,
      },
    },
    nowPlaying: {
      state: "STOPPED",
      source: { id: "CD", name: "CD" },
      display: {
        line1: DISC.album,
        line2: DISC.artist,
        line3: DISC.album,
        mqa: "none",
        playback_source: "CD",
        class: "digital.cd",
        art_url: art,
        stream_id: STREAM_ID,
        progress: null,
        context: null,
      },
      queue: { length: DISC.tracks.length, position: 0, shuffle: "off", repeat: "off" },
      controls: ["play", "play_pause", "track_next", "track_previous"],
    },
  };
}

/** Track `at` (0-based) playing or paused at `position`. */
export function discPlaying(
  host: string,
  at: number,
  state: "play" | "pause",
  position: number,
  modes: { mode_repeat: unknown; mode_shuffle: unknown },
): { playState: Dict; nowPlaying: Dict } {
  const art = `${host}${DISC_ART_PATH}`;
  const [title, secs] = DISC.tracks[at];
  return {
    playState: {
      state,
      position,
      presettable: true,
      ...modes,
      metadata: {
        class: "md.track.cd",
        source: "CD",
        name: "CD",
        album: DISC.album,
        artist: DISC.artist,
        title,
        duration: secs,
        track_number: at + 1,
        art_url: art,
        mqa: "none",
        signal: true,
        stream_id: STREAM_ID,
      },
    },
    nowPlaying: {
      state: state === "play" ? "PLAYING" : "PAUSED",
      source: { id: "CD", name: "CD" },
      display: {
        line1: title,
        line2: DISC.artist,
        line3: DISC.album,
        mqa: "none",
        playback_source: "CD",
        class: "digital.cd",
        art_url: art,
        stream_id: STREAM_ID,
        progress: { position, duration: secs },
        context: `${at + 1}/${DISC.tracks.length}`,
      },
      queue: { length: DISC.tracks.length, position: at, shuffle: "off", repeat: "off" },
      controls: [
        "pause",
        "play_pause",
        "toggle_shuffle",
        "toggle_repeat",
        "track_next",
        "track_previous",
        "seek",
      ],
    },
  };
}

/** The release as MusicBrainz shapes it (?inc=recordings), one CD medium. */
export const discRelease = (): Dict => ({
  id: DISC.release,
  title: DISC.album,
  media: [
    {
      position: 1,
      format: "CD",
      "track-count": DISC.tracks.length,
      tracks: DISC.tracks.map(([title, secs], i) => ({
        position: i + 1,
        number: String(i + 1),
        title,
        length: secs * 1000,
      })),
    },
  ],
});
