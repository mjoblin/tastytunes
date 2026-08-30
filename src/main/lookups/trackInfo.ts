// Track context: who is actually ON the playing recording. MusicBrainz
// recording search -> recording lookup (performer + production relationships)
// -> linked work lookup (composer/lyricist). Three calls through mb.ts's
// 1 rps gate, so a lookup takes a few seconds cold; results cache per
// artist+album+title in a bounded disk-persisted LRU, including DEFINITIVE
// misses. Transient failures return the best partial answer but are never
// cached, so the next request retries. `force` bypasses the cache read for
// the panel's refresh.
//
// This is deliberately a PER-TRACK fetch — the album tab keeps skipping
// recording-level credits because fetching them for a whole album is a
// request burst against the same budget; one playing track is not.
import type { TrackCredit, TrackInfo, TrackInfoQuery } from "@shared/model";
import { DiskCache } from "./diskCache";
import { MB, mbFetch } from "./mb";

const CACHE_MAX = 1000;
const MIN_MATCH_SCORE = 75;

const cache = new DiskCache<TrackInfo>("track", CACHE_MAX);

interface MbRecording {
  id: string;
  title: string;
  score?: number;
  /** Recording length in ms. */
  length?: number;
  video?: boolean;
  releases?: Array<{ title?: string }>;
}

// Same-titled recordings tie on search score (studio take, live takes, edits,
// re-recordings). Two signals the album-tab picker never had break the ties:
// whether the named album is among the recording's releases, and how close
// MB's length is to what is actually playing — studio vs live vs single edit
// usually differ by seconds. Missing length ranks last within its tier.
function pickRecording(
  candidates: MbRecording[],
  album: string | null,
  durationSecs: number | null,
): MbRecording | undefined {
  const albumKey = album?.trim().toLowerCase() ?? null;
  const rank = (r: MbRecording): [number, number] => {
    const onAlbum =
      albumKey != null &&
      (r.releases ?? []).some((rel) => rel.title?.trim().toLowerCase() === albumKey);
    const delta =
      durationSecs != null && r.length != null
        ? Math.abs(r.length - durationSecs * 1000)
        : Number.MAX_SAFE_INTEGER;
    return [onAlbum ? 0 : 1, delta];
  };
  return [...candidates]
    .filter((r) => !r.video)
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      return ra[0] - rb[0] || ra[1] - rb[1];
    })[0];
}

interface MbArtistRel {
  type?: string;
  "target-type"?: string;
  attributes?: string[];
  artist?: { name?: string };
  work?: { id?: string };
}

// MB relationship types -> the drawer's three groups. Instruments and vocal
// types arrive as relationship ATTRIBUTES ("guitar", "lead vocals") — those
// beat the bare type as the shown role. Anything unrecognised lands in
// production with its type capitalised, so new MB vocabulary degrades to
// "shown under a plain name", never to "silently dropped".
const PERFORMER_TYPES = new Set(["instrument", "vocal", "performer", "conductor", "orchestra"]);
const WRITING_TYPES = new Set([
  "composer",
  "lyricist",
  "writer",
  "librettist",
  "translator",
  "arranger",
]);
const PRODUCTION_LABELS: Record<string, string> = {
  producer: "Producer",
  mix: "Mixing",
  recording: "Recording",
  mastering: "Mastering",
  engineer: "Engineering",
  programming: "Programming",
  editor: "Editing",
  "sound effects": "Sound effects",
};

function labelOf(rel: MbArtistRel): string {
  const attr = rel.attributes?.filter((a) => a.trim()).join(", ");
  const base = attr || rel.type || "";
  return base ? base[0].toUpperCase() + base.slice(1) : "";
}

function collect(
  rels: MbArtistRel[],
  into: { performers: TrackCredit[]; production: TrackCredit[]; writing: TrackCredit[] },
  seen: Set<string>,
): void {
  for (const rel of rels) {
    const name = rel.artist?.name;
    const type = rel.type?.toLowerCase();
    if (!name || !type) continue;
    let group: TrackCredit[];
    let role: string;
    if (PERFORMER_TYPES.has(type)) {
      group = into.performers;
      role = type === "vocal" || type === "instrument" ? labelOf(rel) : labelOf({ type });
    } else if (WRITING_TYPES.has(type)) {
      group = into.writing;
      role = labelOf({ type });
    } else {
      group = into.production;
      role = PRODUCTION_LABELS[type] ?? labelOf({ type });
    }
    if (!role) continue;
    const key = `${role}|${name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    group.push({ role, name });
  }
}

export async function fetchTrackInfo(
  query: TrackInfoQuery,
  force = false,
): Promise<TrackInfo | null> {
  const artist = query.artist.trim();
  const title = query.title.trim();
  const album = query.album?.trim() || null;
  if (!artist || !title) return null;
  const key = `${artist}|${album ?? ""}|${title}`.toLowerCase();
  if (!force && cache.has(key)) return cache.get(key) ?? null;

  let result: TrackInfo | null = null;
  // Only a conclusion built purely from real answers goes into the cache.
  let definitive = true;

  const clauses = [`recording:${JSON.stringify(title)}`, `artist:${JSON.stringify(artist)}`];
  if (album) clauses.push(`release:${JSON.stringify(album)}`);
  const searchGot = await mbFetch(
    `${MB}/ws/2/recording?query=${encodeURIComponent(clauses.join(" AND "))}&fmt=json&limit=5`,
  );
  if (searchGot.kind !== "ok") {
    // couldn't even search — nothing to show, nothing to remember
    return null;
  }
  const candidates = ((searchGot.body as { recordings?: MbRecording[] }).recordings ?? []).filter(
    (r) => (r.score ?? 0) >= MIN_MATCH_SCORE,
  );
  const match = pickRecording(candidates, album, query.duration);

  if (match) {
    result = {
      title: match.title,
      performers: [],
      production: [],
      writing: [],
      musicbrainzUrl: `https://musicbrainz.org/recording/${match.id}`,
    };
    const seen = new Set<string>();

    const recGot = await mbFetch(
      `${MB}/ws/2/recording/${match.id}?inc=artist-rels+work-rels&fmt=json`,
    );
    if (recGot.kind !== "ok") {
      definitive = false; // credit state unknown — show the match, retry later
    } else {
      const rels = (recGot.body as { relations?: MbArtistRel[] }).relations ?? [];
      collect(
        rels.filter((r) => r["target-type"] === "artist" || r.artist),
        result,
        seen,
      );

      // Writers live on the WORK, one hop away. Medleys can link several
      // works; the first linked work covers the common case, and one hop is
      // the budget this tab has.
      const workId = rels.find((r) => r.work?.id)?.work?.id;
      if (workId) {
        const workGot = await mbFetch(`${MB}/ws/2/work/${workId}?inc=artist-rels&fmt=json`);
        if (workGot.kind !== "ok") {
          definitive = false;
        } else {
          const workRels = (workGot.body as { relations?: MbArtistRel[] }).relations ?? [];
          collect(
            workRels.filter((r) => WRITING_TYPES.has(r.type?.toLowerCase() ?? "")),
            result,
            seen,
          );
        }
      }
    }
  }
  // no match / low score with an OK search: an answer — cache the null

  if (definitive) cache.set(key, result);
  return result;
}
