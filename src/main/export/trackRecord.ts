import type {
  AudioAnalysis,
  ListeningPlayEvent,
  LyricsResult,
  MediaNode,
  TrackInfo,
} from "@shared/model";
import {
  currentFeatures,
  isListen,
  keyFromStored,
  keyName,
  PITCH_NAMES,
  tempoBpm,
  trackArtists,
  trackPosition,
} from "@shared/model";
import {
  featuresFromStored,
  onsetsFromStored,
  ONSET_TYPES,
  STRIP_BAND_EDGES_HZ,
  stripFromStored,
  type Features,
  type Strip,
} from "@shared/analysisCodec";
import { parseLrc } from "@shared/lrc";
import { buildTimeline, type LyricLine, type Moment, type TimelineSection } from "./timeline";

/**
 * A TRACK AS AN AGENT READS IT (0.17.0, export for an agent): everything TastyTunes knows about
 * one song, as track.json and analysis.json. Pure: the exporter gathers what each source holds
 * (and whether it may ask) and this says it, with every gap named beside its remedy, so an agent
 * never mistakes a lookup that was not made for an answer of none.
 */

export const EXPORT_FORMAT = "tastytunes.export/1";

/** What a lookup gave, or why it gave nothing. */
export type Looked<T> =
  | { kind: "found"; value: T }
  /** The service answered, and has none. */
  | { kind: "none" }
  /** Not asked: the export was made without fill and nothing was known. */
  | { kind: "not_asked" }
  /** Its switch in Settings › Connections is off, so it is never asked. */
  | { kind: "off" }
  /** Asked, and the service didn't answer. */
  | { kind: "unreachable" };

export interface Missing {
  what: string;
  why: string;
  remedy: string;
}

export interface TrackInputs {
  node: MediaNode;
  serverUdn: string;
  serverName: string | null;
  /** The same song elsewhere in the library (another server, another file). */
  copies: Array<{ node: MediaNode; serverUdn: string; serverName: string | null }>;
  analysis: AudioAnalysis | null;
  /** Analysis is switched on in Settings › Appearance, and the file can be read. */
  analysisPossible: { ok: true } | { ok: false; why: string };
  lyrics: Looked<LyricsResult>;
  credits: Looked<TrackInfo>;
  /** This song's play lines from the listening record, any order. */
  plays: ListeningPlayEvent[];
  /** The dated list of every play: only with redact false and plays true. */
  includePlayList: boolean;
  /** The record is switched off: no counts at all. */
  listeningOff: boolean;
  heldBy: { hearted: boolean; albumHearted: boolean; playlists: string[] };
  /** Moments said in local time with their offset (the agent tools' one format). */
  localTime: (ms: number, tzOffsetMin?: number | null) => string;
}

const r = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const arr = (a: ArrayLike<number>, places: number): number[] => Array.from(a, (v) => r(v, places));
const dbfs = (b: number): number => r((b / 255) * 60 - 60, 1);

/** The decoded music features and strip of a stored analysis, the current version's only. */
export function decodedAnalysis(an: AudioAnalysis | null): {
  features: Features | null;
  strip: Strip | null;
  current: boolean;
} {
  const stored = currentFeatures(an?.features);
  return {
    features: stored ? featuresFromStored(stored) : null,
    strip: an?.strip ? stripFromStored(an.strip) : null,
    current: stored != null,
  };
}

/** The synced lines, or the plain text's lines with no time, from a lyrics answer. */
export function lyricLines(l: LyricsResult | null): { synced: boolean; lines: LyricLine[] } {
  if (l?.synced) {
    const lines = parseLrc(l.synced).map((x) => ({ at_seconds: r(x.t, 2), text: x.text }));
    if (lines.length > 0) return { synced: true, lines };
  }
  return { synced: false, lines: [] };
}

/** The song's listening, from its play lines: counts and the first and last by default. */
export function listeningOf(
  plays: ListeningPlayEvent[],
  includeList: boolean,
  localTime: TrackInputs["localTime"],
): Record<string, unknown> {
  const sorted = [...plays].sort((a, b) => a.at - b.at);
  const first = sorted[0];
  const last = sorted.at(-1);
  return {
    plays: sorted.length,
    full_listens: sorted.filter((p) => isListen(p.playedSeconds, p.duration)).length,
    minutes_played: r(sorted.reduce((s, p) => s + p.playedSeconds, 0) / 60, 1),
    first_played: first ? localTime(first.at, first.tzOffsetMin) : null,
    last_played: last ? localTime(last.at, last.tzOffsetMin) : null,
    ...(includeList
      ? {
          every_play: sorted.map((p) => ({
            at: localTime(p.at, p.tzOffsetMin),
            seconds_played: Math.round(p.playedSeconds),
            full_listen: isListen(p.playedSeconds, p.duration),
          })),
        }
      : {}),
  };
}

function fileOf(node: MediaNode, serverUdn: string, serverName: string | null) {
  const f = node.format;
  return {
    server_name: serverName,
    server_udn: serverUdn,
    object_id: node.id,
    codec: f?.codec ?? null,
    bits: f?.bits ?? null,
    sample_rate_hz: f?.rate ?? null,
    kbps: f?.kbps ?? null,
    size_bytes: f?.sizeBytes ?? null,
    channels: f?.channels ?? null,
  };
}

const looked = <T>(l: Looked<T>): T | null => (l.kind === "found" ? l.value : null);

/** Why a lookup gave nothing, and what to do about it, or null when it gave something. */
function gap<T>(l: Looked<T>, what: string, sw: string): Missing | null {
  switch (l.kind) {
    case "found":
    case "none":
      return null;
    case "not_asked":
      return {
        what,
        why: "Not looked up: the export was made without fill.",
        remedy: "Export again with fill: true.",
      };
    case "off":
      return {
        what,
        why: `${sw} is switched off in Settings › Connections.`,
        remedy: `Ask the user to turn on ${sw} in Settings › Connections, then export again with fill: true.`,
      };
    case "unreachable":
      return {
        what,
        why: "The service didn't answer.",
        remedy: "Export again in a moment.",
      };
  }
}

export interface TrackRecord {
  track: Record<string, unknown>;
  /** analysis.json, or null when the track has no current analysis. */
  analysis: Record<string, unknown> | null;
  timeline: { sections: TimelineSection[]; moments: Moment[] };
  missing: Missing[];
}

export function buildTrackRecord(i: TrackInputs): TrackRecord {
  const n = i.node;
  const an = i.analysis;
  const { features, strip, current } = decodedAnalysis(an);
  const lyrics = looked(i.lyrics);
  const { synced, lines } = lyricLines(lyrics);
  const timeline = buildTimeline(features, strip, lines, n.durationSecs);
  const missing: Missing[] = [];

  if (!an || !current) {
    missing.push({
      what: "analysis",
      why: !an
        ? "Not analyzed yet."
        : "Analyzed by an older version, whose tempo and sections are not given.",
      remedy: i.analysisPossible.ok
        ? "Call analyze_album with this track's album (the TastyTunes window must be open), then export again when it is measured."
        : i.analysisPossible.why,
    });
  }
  const lyricsGap = gap(i.lyrics, "lyrics", "Lyrics");
  if (lyricsGap) missing.push(lyricsGap);
  const creditsGap = gap(i.credits, "credits", "Liner notes");
  if (creditsGap) missing.push(creditsGap);
  if (lyrics && !lyrics.instrumental && !synced)
    missing.push({
      what: "synced lyrics",
      why: "LRCLIB has the words without times, so the timeline has no lyric lines.",
      remedy: "None from TastyTunes: the plain text is in lyrics.plain.",
    });

  const credits = looked(i.credits);
  const track: Record<string, unknown> = {
    format: EXPORT_FORMAT,
    identity: {
      title: n.title,
      artist: n.artist,
      artists: trackArtists(n),
      album: n.album,
      album_artist: n.albumArtist ?? null,
      track_number: trackPosition(n),
      disc_number: n.discNumber ?? null,
      year: n.year,
      genres: n.genre ?? [],
      composers: n.composers ?? [],
      duration_seconds: n.durationSecs != null ? r(n.durationSecs, 2) : null,
    },
    file: fileOf(n, i.serverUdn, i.serverName),
    other_copies: i.copies.map((c) => fileOf(c.node, c.serverUdn, c.serverName)),
    measured: an
      ? {
          dr: an.dr > 0 ? an.dr : null,
          lufs: an.lufs != null ? r(an.lufs, 1) : null,
          loudness_range_lu: an.lra != null ? r(an.lra, 1) : null,
          true_peak_dbtp: an.truePeakDb != null ? r(an.truePeakDb, 1) : null,
          peak_db: an.peakDb != null ? r(an.peakDb, 1) : null,
          rms_db: an.rmsDb != null ? r(an.rmsDb, 1) : null,
          tempo_bpm: current ? tempoBpm(currentFeatures(an.features)?.beats) : null,
          key: current ? keyName(keyFromStored(currentFeatures(an.features))) : null,
          details: current ? "analysis.json" : null,
        }
      : null,
    lyrics:
      lyrics == null
        ? null
        : {
            instrumental: lyrics.instrumental,
            synced,
            lines,
            plain: lyrics.plain,
            source: "LRCLIB (lrclib.net)",
          },
    credits: credits
      ? {
          performers: credits.performers,
          production: credits.production,
          writing: credits.writing,
          musicbrainz: credits.musicbrainzUrl,
        }
      : null,
    listening: i.listeningOff ? null : listeningOf(i.plays, i.includePlayList, i.localTime),
    held_by: {
      hearted: i.heldBy.hearted,
      album_hearted: i.heldBy.albumHearted,
      playlists: i.heldBy.playlists,
    },
    timeline,
  };

  return {
    track,
    analysis: an && current ? analysisJson(n, an, features, strip) : null,
    timeline,
    missing,
  };
}

/** analysis.json: the whole analysis, decoded, in seconds and plain units. */
function analysisJson(
  n: MediaNode,
  an: AudioAnalysis,
  f: Features | null,
  strip: Strip | null,
): Record<string, unknown> {
  const onsets = an.onsets ? onsetsFromStored(an.onsets) : null;
  const key = keyFromStored(currentFeatures(an.features));
  const frames = (fps: number, len: number) => ({ fps, frames: len });
  return {
    format: EXPORT_FORMAT,
    track: { title: n.title, artist: n.artist, album: n.album },
    /** The music features' version that measured it (a later version measures again). */
    analysis_version: an.features?.version ?? null,
    tempo: f?.beats
      ? {
          bpm: r(f.beats.bpm, 2),
          confidence: r(f.beats.confidence, 2),
          downbeat_index: f.beats.downbeat >= 0 ? f.beats.downbeat : null,
          beats_seconds: arr(f.beats.times, 3),
        }
      : null,
    key: key
      ? { name: `${PITCH_NAMES[key.tonic]} ${key.mode}`, confidence: r(key.confidence, 2) }
      : null,
    sections: f?.sections
      ? {
          bounds_seconds: arr(f.sections.bounds, 2),
          kinds: Array.from(f.sections.kinds, (k) => (k === 1 ? "repeated_loud" : "other")),
          energy: arr(f.sections.energy, 2),
        }
      : null,
    chord_changes_seconds: f ? arr(f.changes, 2) : [],
    silences: f
      ? Array.from({ length: Math.floor(f.silences.length / 2) }, (_, k) => ({
          start_seconds: r(f.silences[2 * k], 2),
          end_seconds: r(f.silences[2 * k + 1], 2),
        }))
      : [],
    drops: f
      ? Array.from(f.drops.at, (at, k) => ({
          build_from_seconds: r(f.drops.buildFrom[k] ?? at, 2),
          at_seconds: r(at, 2),
          strength: r(f.drops.strength[k] ?? 0, 2),
          reduced_seconds: r(f.drops.chill[k] ?? 0, 2),
          near_silent_seconds: r(f.drops.breath[k] ?? 0, 2),
          cut_seconds: r(f.drops.cut[k] ?? 0, 2),
        }))
      : [],
    onsets: onsets
      ? {
          kinds: [...ONSET_TYPES],
          at_seconds: arr(onsets.at, 2),
          strength: arr(onsets.strength, 2),
          kind: Array.from(onsets.type, (t) => ONSET_TYPES[t] ?? "kick"),
        }
      : null,
    curves: {
      loudness_dbfs: strip
        ? { ...frames(strip.fps, strip.loud.length), values: Array.from(strip.loud, dbfs) }
        : null,
      bands_dbfs: strip
        ? {
            ...frames(strip.fps, strip.loud.length),
            edges_hz: [...STRIP_BAND_EDGES_HZ],
            values: Array.from({ length: strip.loud.length }, (_, fr) => {
              const bands = strip.bands.length / Math.max(1, strip.loud.length);
              return Array.from(strip.bands.subarray(fr * bands, (fr + 1) * bands), dbfs);
            }),
          }
        : null,
      brightness: f?.timbre
        ? {
            ...frames(f.timbre.fps, f.timbre.brightness.length),
            values: arr(f.timbre.brightness, 2),
          }
        : null,
      noisiness: f?.timbre
        ? { ...frames(f.timbre.fps, f.timbre.noisiness.length), values: arr(f.timbre.noisiness, 2) }
        : null,
      pan: f?.stereo
        ? { ...frames(f.stereo.fps, f.stereo.pan.length), values: arr(f.stereo.pan, 2) }
        : null,
      width: f?.stereo
        ? { ...frames(f.stereo.fps, f.stereo.width.length), values: arr(f.stereo.width, 2) }
        : null,
      chroma: f?.chroma
        ? {
            ...frames(f.chroma.fps, Math.floor(f.chroma.data.length / 12)),
            pitch_classes: [...PITCH_NAMES],
            values: Array.from({ length: Math.floor(f.chroma.data.length / 12) }, (_, fr) =>
              arr(f.chroma!.data.subarray(fr * 12, fr * 12 + 12), 2),
            ),
          }
        : null,
    },
    waveform: {
      points: an.peakQ.length,
      peak: an.peakQ.map((v) => r(v / 1000, 3)),
      rms: an.rmsQ.map((v) => r(v / 1000, 3)),
    },
  };
}
