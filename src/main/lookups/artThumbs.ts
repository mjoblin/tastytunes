import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, nativeImage } from "electron";

/**
 * ALBUM ART THUMBNAILS for servers that cannot be asked for a size (2026-09-14,
 * from a user's USB report: the streamer's own USB server ignores every size
 * hint and serves the embedded picture whole — 1400 × 1400, 827 KB, ~0.8 s a
 * request, no cache headers — and its art URL carries the stick's mount
 * counter, so Chromium re-fetched every card on every visit and a URL-keyed
 * cache would empty on every standby). Asset resizes on request and keeps its
 * own path (shared/artUrl); everything else draws through here.
 *
 * Two tiers, made on first draw and never prefetched: a 320 px thumb for the
 * row and medium sites and a 480 px card for the 240 px sites, JPEG at 85
 * (the recentcover precedent); the Now Playing hero keeps the original. Keyed
 * by CONTENT — server, album title, album artist — so a rotated id finds the
 * same file; a caller with only a URL keys by the URL. A picture the resizer
 * cannot read (SVG) is kept as it came, bounded. Files live under
 * userData/cache/art/<tier>/<sha1 of version|tier|key>.<jpg|origin ext>
 * beside a small index.json; least-recently-drawn entries go when the budget
 * is passed; Settings shows the size and clears it. Served through
 * the tt-art: protocol (main/index.ts) with a long cache lifetime, so the
 * browser cache answers re-draws without asking main.
 */

export const TIERS = { thumb: 320, card: 480 } as const;
export type ArtTier = keyof typeof TIERS;

const VERSION = 1; // salted into every id: a format change misses cleanly
const BUDGET_BYTES = 200 * 1024 * 1024;
const PASSTHROUGH_MAX = 2 * 1024 * 1024;
const MAX_PARALLEL = 3;
const WRITE_DELAY_MS = 2000;
const JPEG_QUALITY = 85;

interface Entry {
  bytes: number;
  /** Last drawn (ms epoch) — the eviction key. */
  at: number;
  type: string;
  tier: ArtTier;
  /** The file's extension: jpg for a resized picture, the origin's own for one kept as it came. */
  ext: string;
}

let index: Map<string, Entry> | null = null;
let timer: NodeJS.Timeout | null = null;
const inflight = new Map<string, Promise<{ bytes: Buffer; type: string } | null>>();
let running = 0;
const waiters: Array<() => void> = [];

const dir = (): string => join(app.getPath("userData"), "cache", "art");
const indexFile = (): string => join(dir(), "index.json");
const fileFor = (id: string, e: Pick<Entry, "tier" | "ext">): string =>
  join(dir(), e.tier, `${id}.${e.ext}`);
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const extFor = (type: string): string => EXT[type.split(";")[0].trim().toLowerCase()] ?? "bin";
const idFor = (key: string, tier: ArtTier): string =>
  createHash("sha1").update(`${VERSION}|${tier}|${key}`).digest("hex");

function load(): Map<string, Entry> {
  if (index) return index;
  index = new Map();
  try {
    const raw = JSON.parse(readFileSync(indexFile(), "utf8")) as {
      version?: number;
      entries?: [string, Entry][];
    };
    if (raw.version === VERSION && Array.isArray(raw.entries)) index = new Map(raw.entries);
  } catch {
    // first run, or unreadable — start empty
  }
  return index;
}

function save(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(flushArtThumbs, WRITE_DELAY_MS);
}

/** Write the index now (quit, and the debounced write). */
export function flushArtThumbs(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!index) return;
  try {
    mkdirSync(dir(), { recursive: true });
    const tmp = `${indexFile()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: VERSION, entries: [...index] }));
    renameSync(tmp, indexFile());
  } catch {
    // a lost index only costs the thumbnails a re-make
  }
}

function evict(map: Map<string, Entry>): void {
  let total = 0;
  for (const e of map.values()) total += e.bytes;
  if (total <= BUDGET_BYTES) return;
  const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [id, e] of oldest) {
    if (total <= BUDGET_BYTES) break;
    map.delete(id);
    total -= e.bytes;
    try {
      rmSync(fileFor(id, e), { force: true });
    } catch {
      // gone already
    }
  }
}

async function gate<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiters.push(r));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

async function fetchOrigin(url: string): Promise<{ raw: Buffer; type: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return {
      raw: Buffer.from(await res.arrayBuffer()),
      type: res.headers.get("content-type") ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}

/**
 * The picture for `key` at `tier`: from the cache, else fetched from `origin`
 * once, resized, stored and served. Null when the origin does not answer.
 */
export function artThumb(
  key: string,
  tier: ArtTier,
  origin: string,
): Promise<{ bytes: Buffer; type: string } | null> {
  const map = load();
  const id = idFor(key, tier);
  const hit = map.get(id);
  if (hit) {
    try {
      const bytes = readFileSync(fileFor(id, hit));
      hit.at = Date.now();
      save();
      return Promise.resolve({ bytes, type: hit.type });
    } catch {
      map.delete(id); // the file went; make it again
    }
  }
  const pending = inflight.get(id);
  if (pending) return pending;
  const run = gate(async () => {
    const got = await fetchOrigin(origin);
    if (!got) return null;
    let bytes = got.raw;
    let type = got.type;
    const img = nativeImage.createFromBuffer(got.raw);
    if (!img.isEmpty()) {
      const { width } = img.getSize();
      const shown = width > TIERS[tier] ? img.resize({ width: TIERS[tier], quality: "good" }) : img;
      bytes = shown.toJPEG(JPEG_QUALITY);
      type = "image/jpeg";
    } else if (bytes.length > PASSTHROUGH_MAX) {
      return { bytes, type }; // too big to keep as it came; served once, not stored
    }
    const entry: Entry = { bytes: bytes.length, at: Date.now(), type, tier, ext: extFor(type) };
    try {
      mkdirSync(join(dir(), tier), { recursive: true });
      writeFileSync(fileFor(id, entry), bytes);
      map.set(id, entry);
      evict(map);
      save();
    } catch {
      // the disk said no; the picture still draws this once
    }
    return { bytes, type };
  }).finally(() => inflight.delete(id));
  inflight.set(id, run);
  return run;
}

export function artThumbsStats(): { entries: number; bytes: number } {
  const map = load();
  let bytes = 0;
  for (const e of map.values()) bytes += e.bytes;
  return { entries: map.size, bytes };
}

export function clearArtThumbs(): { entries: number; bytes: number } {
  const map = load();
  for (const [id, e] of map) {
    try {
      rmSync(fileFor(id, e), { force: true });
    } catch {
      // gone already
    }
  }
  map.clear();
  if (existsSync(indexFile())) rmSync(indexFile(), { force: true });
  return { entries: 0, bytes: 0 };
}
