import { join } from "node:path";
import { app } from "electron";
import { isRecord } from "@shared/guards";
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

const store = jsonFileStore<Record<string, ServerArrivals>>({
  pathOf: () => join(app.getPath("userData"), "album-arrivals.json"),
  scope: "album-arrivals",
  load: (parsed) => {
    const out: Record<string, ServerArrivals> = {};
    if (!isRecord(parsed)) return out;
    for (const [udn, v] of Object.entries(parsed)) {
      if (!isRecord(v) || typeof v.since !== "number" || !isRecord(v.keys)) continue;
      const keys: Record<string, number> = {};
      for (const [k, at] of Object.entries(v.keys)) if (typeof at === "number") keys[k] = at;
      out[udn] = { since: v.since, keys };
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
  const known = all[udn];
  const keys = albums.map((a) => arrivalKey(a, stableArt));
  if (!known) {
    store.set({ ...all, [udn]: { since: now, keys: Object.fromEntries(keys.map((k) => [k, 0])) } });
    return;
  }
  const fresh = [...new Set(keys)].filter((k) => !(k in known.keys));
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
