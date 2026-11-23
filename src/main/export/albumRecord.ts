import type { AlbumInfo, MediaNode } from "@shared/model";
import { trackPosition } from "@shared/model";
import { EXPORT_FORMAT, type Looked, type Missing, type TrackRecord } from "./trackRecord";

/**
 * AN ALBUM AS AN AGENT READS IT (0.17.0, export for an agent): album.json, the album's identity,
 * its notes, what was measured across it, and its tracks in running order with the folder each
 * track's own export sits in. Pure, like the track's.
 */

export interface AlbumInputs {
  album: MediaNode;
  serverUdn: string;
  serverName: string | null;
  tracks: Array<{ folder: string; node: MediaNode; record: TrackRecord }>;
  notes: Looked<AlbumInfo>;
  /** The album's DR and loudness, recorded only when every track is measured. */
  measured: { dr: number; lufs?: number | null } | null;
  hearted: boolean;
}

export function buildAlbumRecord(i: AlbumInputs): {
  album: Record<string, unknown>;
  missing: Missing[];
} {
  const missing: Missing[] = [];
  const notes = i.notes.kind === "found" ? i.notes.value : null;
  if (i.notes.kind === "not_asked")
    missing.push({
      what: "album notes",
      why: "Not looked up: the export was made without fill.",
      remedy: "Export again with fill: true.",
    });
  if (i.notes.kind === "off")
    missing.push({
      what: "album notes",
      why: "Liner notes is switched off in Settings › Connections.",
      remedy:
        "Ask the user to turn on Liner notes in Settings › Connections, then export again with fill: true.",
    });
  if (i.notes.kind === "unreachable")
    missing.push({
      what: "album notes",
      why: "MusicBrainz didn't answer.",
      remedy: "Export again in a moment.",
    });
  // a gap every track shares is said once here, with how many tracks it touches
  const byWhat = new Map<string, { m: Missing; tracks: string[] }>();
  for (const t of i.tracks)
    for (const m of t.record.missing) {
      const k = `${m.what}|${m.why}`;
      const seen = byWhat.get(k) ?? { m, tracks: [] };
      seen.tracks.push(t.node.title);
      byWhat.set(k, seen);
    }
  for (const { m, tracks } of byWhat.values())
    missing.push({
      ...m,
      what: `${m.what} (${tracks.length} of ${i.tracks.length} tracks)`,
    });

  const seconds = i.tracks.reduce((s, t) => s + (t.node.durationSecs ?? 0), 0);
  const discs = new Set(i.tracks.map((t) => t.node.discNumber ?? 1));
  const analyzed = i.tracks.filter((t) => t.record.analysis != null).length;
  const a = i.album;
  return {
    album: {
      format: EXPORT_FORMAT,
      identity: {
        title: a.title,
        artist: a.artist,
        year: a.year ?? notes?.year ?? null,
        genres: a.genre ?? notes?.genres ?? [],
        tracks: i.tracks.length,
        discs: discs.size,
        duration_seconds: Math.round(seconds),
        server_name: i.serverName,
        server_udn: i.serverUdn,
        object_id: a.id,
      },
      measured: {
        tracks_analyzed: analyzed,
        of: i.tracks.length,
        dr: i.measured && i.measured.dr > 0 ? i.measured.dr : null,
        lufs: i.measured?.lufs != null ? Math.round(i.measured.lufs * 10) / 10 : null,
        note: "The album's DR and loudness are given only when every track is analyzed.",
      },
      notes: notes
        ? {
            title: notes.title,
            year: notes.year,
            type: notes.type,
            label: notes.label,
            genres: notes.genres,
            credits: notes.credits,
            summary: notes.summary,
            wikipedia: notes.wikipediaUrl,
            musicbrainz: notes.musicbrainzUrl,
          }
        : null,
      held_by: { hearted: i.hearted },
      tracks: i.tracks.map((t) => ({
        disc: t.node.discNumber ?? null,
        number: trackPosition(t.node),
        title: t.node.title,
        artist: t.node.artist,
        duration_seconds: t.node.durationSecs != null ? Math.round(t.node.durationSecs) : null,
        folder: t.folder,
        analyzed: t.record.analysis != null,
        synced_lyrics: (t.record.track.lyrics as { synced?: boolean } | null)?.synced === true,
      })),
    },
    missing,
  };
}
