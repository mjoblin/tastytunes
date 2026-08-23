import { readFileSync } from "node:fs";
import { isRecord } from "@shared/guards";
import { join } from "node:path";
import { app } from "electron";
import { type RecentTrack, MAX_RECENTS } from "@shared/model";
import { atomicWriteFileSync } from "./jsonStore";

// A bounded ring of recently-played tracks, persisted beside settings.json.
// Kept out of settings.json on purpose: it's a churning log, cleared on its own,
// and shouldn't bloat the settings file the user might inspect or sync.

let cached: RecentTrack[] | null = null;

function recentsPath(): string {
  return join(app.getPath("userData"), "recents.json");
}

/**
 * Identity used to collapse the same track repeating back-to-back. Keyed on the
 * title alone (station + title for radio, so each song on a station still logs),
 * NOT the artist: real streamers push a track twice — first a partial frame with
 * only the title, then the full metadata — and keying on artist would treat those
 * as two different tracks. Artist/album/art are treated as fields to merge in.
 */
function recentKey(e: RecentTrack): string {
  return e.isRadio ? `r:${e.station ?? ""}:${e.title ?? ""}` : `t:${e.title ?? ""}`;
}

/** Fill any field missing on `base` from `other`; `base` keeps its identity/time. */
function mergeEntries(base: RecentTrack, other: RecentTrack): RecentTrack {
  return {
    at: base.at,
    title: base.title ?? other.title,
    artist: base.artist ?? other.artist,
    album: base.album ?? other.album,
    station: base.station ?? other.station,
    artUrl: base.artUrl ?? other.artUrl,
    source: base.source ?? other.source,
    sourceId: base.sourceId ?? other.sourceId,
    queueId: base.queueId ?? other.queueId,
    isRadio: base.isRadio,
    radioId: base.radioId ?? other.radioId,
    session: base.session ?? other.session,
  };
}

/** Backfill fields added in later versions so older logs load with a consistent shape. */
function normalize(e: RecentTrack): RecentTrack {
  const isRadio = !!e.isRadio;
  return {
    at: e.at,
    title: e.title ?? null,
    artist: e.artist ?? null,
    album: e.album ?? null,
    station: e.station ?? null,
    artUrl: e.artUrl ?? null,
    source: e.source ?? null,
    sourceId: e.sourceId ?? null,
    queueId: e.queueId ?? null,
    isRadio,
    radioId: e.radioId ?? null,
    // Legacy rows only knew radio-vs-not; group legacy radio by station, others as discrete.
    session: e.session !== undefined ? e.session : isRadio ? `radio:${e.station ?? ""}` : null,
  };
}

function sameFields(a: RecentTrack, b: RecentTrack): boolean {
  return (
    a.title === b.title &&
    a.artist === b.artist &&
    a.album === b.album &&
    a.station === b.station &&
    a.artUrl === b.artUrl &&
    a.source === b.source
  );
}

/** Merge any runs of consecutive same-key entries down to one (newest-first list). */
function collapseConsecutive(list: RecentTrack[]): RecentTrack[] {
  const out: RecentTrack[] = [];
  for (const e of list) {
    const prev = out[out.length - 1];
    if (prev && recentKey(prev) === recentKey(e)) {
      const merged = mergeEntries(prev, e);
      merged.at = Math.min(prev.at, e.at); // keep the earliest sighting
      out[out.length - 1] = merged;
    } else {
      out.push(e);
    }
  }
  return out;
}

const isRecentTrack = (x: unknown): x is RecentTrack => isRecord(x) && typeof x.at === "number";

export function getRecents(): RecentTrack[] {
  if (cached) return cached;
  let raw: RecentTrack[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(recentsPath(), "utf-8"));
    // our own file: keep the rows that have the one field everything sorts on
    if (Array.isArray(parsed)) raw = parsed.filter(isRecentTrack);
  } catch {
    raw = [];
  }
  // Upgrade older rows to the current shape, then collapse duplicates from the
  // era before dedup was title-based.
  const upgraded = raw.some(
    (e) => e.session === undefined || e.sourceId === undefined || e.queueId === undefined,
  );
  const list = raw.map(normalize);
  const collapsed = collapseConsecutive(list);
  cached = collapsed;
  if (upgraded || collapsed.length !== raw.length) save(collapsed);
  return cached;
}

function save(list: RecentTrack[]): void {
  cached = list;
  try {
    // atomic (temp + rename): a crash mid-write must not truncate the log.
    // The load side stays local — its upgrade/collapse pass is domain logic,
    // not persistence (see jsonStore for the stores that fit the factory).
    atomicWriteFileSync(recentsPath(), JSON.stringify(list));
  } catch (err) {
    console.error("failed to persist recents", err);
  }
}

/**
 * Record a played track. Consecutive-dedupes against the newest entry (so a
 * pause/resume, a partial-then-full metadata frame, or a repeated push doesn't
 * add a row), merging in fields — artist, album, art — that arrive after the
 * first push. Returns the updated list plus whether anything actually changed,
 * so the caller can skip a redundant push.
 */
export function recordRecent(entry: RecentTrack): { list: RecentTrack[]; changed: boolean } {
  const list = getRecents();
  const head = list[0];
  if (head && recentKey(head) === recentKey(entry)) {
    const merged = mergeEntries(head, entry);
    if (sameFields(merged, head)) return { list, changed: false };
    list[0] = merged;
    save(list);
    return { list, changed: true };
  }
  const next = [entry, ...list];
  if (next.length > MAX_RECENTS) next.length = MAX_RECENTS;
  save(next);
  return { list: next, changed: true };
}

export function clearRecents(): RecentTrack[] {
  save([]);
  return cached!;
}

/**
 * Undo a clear: put the log back.
 *
 * MERGES rather than overwrites. Clearing offers an undo for a few seconds, and
 * the streamer doesn't stop playing while that offer is up — a track that got
 * recorded in between is newer than everything in the snapshot, and restoring
 * the snapshot wholesale would silently drop it. Whatever is in the log now
 * stays on top; the snapshot fills in beneath it.
 *
 * Deduped on time + identity so a double-fired undo can't double the log, and
 * bounded like every other write here.
 */
export function restoreRecents(list: RecentTrack[]): RecentTrack[] {
  const seen = new Set<string>();
  const merged: RecentTrack[] = [];
  for (const entry of [...getRecents(), ...list.map(normalize)]) {
    const key = `${entry.at}:${recentKey(entry)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  save(merged.slice(0, MAX_RECENTS));
  return cached!;
}
