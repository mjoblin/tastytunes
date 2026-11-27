import { join } from "node:path";
import { app } from "electron";
import { isRecord, kindOf } from "@shared/guards";
import type { MediaNode } from "@shared/model";
import { arrivalKey } from "@shared/recentlyAdded";
import { jsonFileStore } from "./jsonStore";

// WHEN EACH ALBUM ARRIVED (0.13.0 round 9; shared/recentlyAdded says what Recently added is). Per
// server, every album the indexes have held, by its arrival key, with the day it first appeared;
// 0 for the albums that were there when the server's first index was seen here, whose day nobody
// knows. Beside settings.json, not in the cache folder: Clear in Settings › Libraries and an
// index format change rebuild the indexes, and the dates outlive both. Keys are never dropped,
// so an album that leaves and comes back is not new.

interface ServerArrivals {
  /** When this server's first index was seen. */
  since: number;
  keys: Record<string, number>;
}

/** A rebuild that finds more than this share of a server's albums new (and more than
 *  CHURN_FLOOR of them) is the server renaming them, not an import: they join the undated. */
const CHURN_SHARE = 0.5;
const CHURN_FLOOR = 20;

// a later version's servers this one doesn't read, and on a server it does an album's arrival in a
// form it doesn't (1.0 is the oldest reader such a file will meet): kept out of the app and
// written back as found; a carried server isn't noted over, and a carried album isn't new
let carried: Record<string, unknown> = {};
let carriedKeys: Record<string, Record<string, unknown>> = {};
let carriedNotes: string[] = [];

const store = jsonFileStore<Record<string, ServerArrivals>>({
  pathOf: () => join(app.getPath("userData"), "album-arrivals.json"),
  scope: "album-arrivals",
  encode: (next) => {
    const out: Record<string, unknown> = { ...carried };
    for (const [udn, s] of Object.entries(next)) {
      const later = carriedKeys[udn];
      out[udn] = later ? { ...s, keys: { ...later, ...s.keys } } : s;
    }
    return out;
  },
  kept: () => carriedNotes,
  load: (parsed, setAside) => {
    carried = {};
    carriedKeys = {};
    carriedNotes = [];
    const out: Record<string, ServerArrivals> = {};
    if (parsed === undefined) return out;
    if (!isRecord(parsed)) {
      setAside.push(`the file was ${kindOf(parsed)}, not a set of servers, so none were read`);
      return out;
    }
    for (const [udn, v] of Object.entries(parsed)) {
      if (!isRecord(v) || typeof v.since !== "number" || !isRecord(v.keys)) {
        if (isRecord(v)) {
          carried[udn] = v;
          carriedNotes.push(`the server ${udn} isn't one this version reads, kept as it was`);
        } else setAside.push(`the server ${udn} wasn't one this version reads, left out`);
        continue;
      }
      const keys: Record<string, number> = {};
      const later: Record<string, unknown> = {};
      for (const [k, at] of Object.entries(v.keys)) {
        if (typeof at === "number") keys[k] = at;
        else later[k] = at;
      }
      if (Object.keys(later).length > 0) {
        carriedKeys[udn] = later;
        carriedNotes.push(
          `${Object.keys(later).length} of the server ${udn}'s albums aren't in a form this version reads, kept as they were`,
        );
      }
      // a field this version doesn't know (a later version's) is kept, and written back with the
      // server's next change (noteArrivals spreads the server)
      out[udn] = { ...v, since: v.since, keys };
    }
    return out;
  },
});

/**
 * An index of the server was built (or is held from before this shipped): its albums are noted.
 * The first index seen for a server is its baseline, every album undated; after that an album
 * not seen before arrived now, unless so many did at once that the server renamed them.
 */
export function noteArrivals(
  udn: string,
  albums: ReadonlyArray<Pick<MediaNode, "title" | "artist" | "albumArtist" | "artUrl">>,
  stableArt: boolean,
  now = Date.now(),
): void {
  const all = store.get();
  // a later version's record of this server stands as it is
  if (udn in carried) return;
  const known = all[udn];
  const keys = albums.map((a) => arrivalKey(a, stableArt));
  if (!known) {
    store.set({ ...all, [udn]: { since: now, keys: Object.fromEntries(keys.map((k) => [k, 0])) } });
    return;
  }
  const later = carriedKeys[udn] ?? {};
  const fresh = [...new Set(keys)].filter((k) => !(k in known.keys) && !(k in later));
  if (fresh.length === 0) return;
  const churn = fresh.length > CHURN_FLOOR && fresh.length > keys.length * CHURN_SHARE;
  if (churn)
    console.log(
      `[arrivals] ${udn}: ${fresh.length} of ${keys.length} albums new at once, read as renamed`,
    );
  const next = { ...known.keys };
  for (const k of fresh) next[k] = churn ? 0 : now;
  store.set({ ...all, [udn]: { ...known, keys: next } });
}

/** A server's albums' arrival days by arrival key (0 when unknown); empty before its first index. */
export function arrivalsOf(udn: string): Readonly<Record<string, number>> {
  return store.get()[udn]?.keys ?? {};
}
