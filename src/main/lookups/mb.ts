// Shared MusicBrainz / Wikidata / Wikipedia plumbing for the context lookups
// (artist bios, album details). MusicBrainz enforces ONE request per second
// per IP and an identifying User-Agent (violators get 100% declined) — every
// MB call from anywhere in the app goes through the single spacing gate here.
import { loggedFetch, USER_AGENT } from "../netlog";

// Env overrides let test harnesses point each hop at a local server.
export const MB = process.env["TASTYTUNES_MB_URL"] ?? "https://musicbrainz.org";
export const WD = process.env["TASTYTUNES_WD_URL"] ?? "https://www.wikidata.org";
export const WIKI = process.env["TASTYTUNES_WIKI_URL"] ?? "https://en.wikipedia.org";

/** ok = an answer; missing = authoritative 404; error = we never really asked
 *  (status when the server said so — 503 is MusicBrainz refusing the pace;
 *  dropped when the gate discarded a speculative request unsent). */
export type Fetched =
  | { kind: "ok"; body: unknown }
  | { kind: "missing" }
  | { kind: "error"; status?: number; dropped?: boolean };

export async function getJson(service: string, url: string): Promise<Fetched> {
  try {
    const res = await loggedFetch(service, url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) return { kind: "error", status: res.status };
    return { kind: "ok", body: await res.json() };
  } catch {
    return { kind: "error" };
  }
}

// The MusicBrainz 1 rps gate: calls queue behind each other, spaced >= 1.1s.
// TWO LANES (2026-09-12): a lookup the user asked for — the context panel's
// tab, an opened row on History's Elsewhere, an agent's question — goes ahead
// of every speculative one still waiting (cover art for rows on screen),
// behind only the urgent ones already there. The pace is the same either way.
// GENTLE (same day, after a log showing four refusals in ten at the published
// pace — user: "i don't want the app to be too demanding on musicbrainz"):
// a 503 pauses the gate, two seconds doubling to thirty, the refused request
// is retried ONCE after the pause, and a success forgets the pause; and the
// speculative lane holds at most MB_SPECULATIVE_MAX waiting requests — beyond
// that the oldest are discarded unsent, since their rows have scrolled away,
// and answer as an error so nothing caches. Urgent requests are never dropped.
interface MbJob {
  url: string;
  urgent: boolean;
  resolve(got: Fetched): void;
}
const MB_SPACING_MS = 1100;
const MB_BACKOFF_MIN_MS = 2000;
const MB_BACKOFF_MAX_MS = 30_000;
const MB_SPECULATIVE_MAX = 8;
const mbQueue: MbJob[] = [];
let mbPumping = false;
let mbLastAt = 0;
let mbBackoff = 0;
let mbNotBefore = 0;
export function mbFetch(url: string, urgent = false): Promise<Fetched> {
  return new Promise((resolve) => {
    const job: MbJob = { url, urgent, resolve };
    if (urgent) {
      const firstWaiting = mbQueue.findIndex((j) => !j.urgent);
      if (firstWaiting < 0) mbQueue.push(job);
      else mbQueue.splice(firstWaiting, 0, job);
    } else {
      mbQueue.push(job);
      const waiting = mbQueue.filter((j) => !j.urgent);
      while (waiting.length > MB_SPECULATIVE_MAX) {
        const stale = waiting.shift() as MbJob;
        mbQueue.splice(mbQueue.indexOf(stale), 1);
        stale.resolve({ kind: "error", dropped: true });
      }
    }
    void pumpMb();
  });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** One request at the gate's pace, honouring a pause a 503 imposed. */
async function paced(url: string): Promise<Fetched> {
  const wait = Math.max(mbLastAt + MB_SPACING_MS, mbNotBefore) - Date.now();
  if (wait > 0) await sleep(wait);
  mbLastAt = Date.now();
  const got = await getJson("musicbrainz", url);
  if (got.kind === "error" && got.status === 503) {
    mbBackoff = mbBackoff === 0 ? MB_BACKOFF_MIN_MS : Math.min(mbBackoff * 2, MB_BACKOFF_MAX_MS);
    mbNotBefore = Date.now() + mbBackoff;
  } else if (got.kind !== "error") {
    mbBackoff = 0;
    mbNotBefore = 0;
  }
  return got;
}
async function pumpMb(): Promise<void> {
  if (mbPumping) return;
  mbPumping = true;
  try {
    for (let job = mbQueue.shift(); job; job = mbQueue.shift()) {
      let got = await paced(job.url);
      // one retry after the pause; a second refusal is the answer for now
      if (got.kind === "error" && got.status === 503) got = await paced(job.url);
      job.resolve(got);
    }
  } finally {
    mbPumping = false;
  }
}

export interface MbRelation {
  type?: string;
  url?: { resource?: string };
}

/**
 * Resolve a Wikipedia summary from MB url-rels: a direct wikipedia rel
 * (legacy) or wikidata -> enwiki sitelink -> REST summary. `definitive:
 * false` means a transient failure somewhere in the chain — show what we
 * have, but don't cache it.
 */
export async function wikipediaFromRels(
  rels: MbRelation[],
): Promise<{ summary: string | null; wikipediaUrl: string | null; definitive: boolean }> {
  let definitive = true;
  let title: string | null = null;

  const wikipedia = rels.find((r) => r.type === "wikipedia")?.url?.resource;
  if (wikipedia) {
    title = decodeURIComponent(wikipedia.split("/wiki/")[1] ?? "");
  } else {
    const wikidata = rels.find((r) => r.type === "wikidata")?.url?.resource;
    const qid = wikidata?.split("/wiki/")[1];
    if (qid) {
      const entityGot = await getJson("wikidata", `${WD}/wiki/Special:EntityData/${qid}.json`);
      if (entityGot.kind === "error") {
        definitive = false;
      } else if (entityGot.kind === "ok") {
        const entities = (
          entityGot.body as {
            entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } }>;
          }
        ).entities;
        title = entities?.[qid]?.sitelinks?.enwiki?.title ?? null;
      }
      // 'missing' = no such entity: an answer, stays definitive
    }
    // no wikidata relation at all: an answer — no summary to link
  }

  let summary: string | null = null;
  let wikipediaUrl: string | null = null;
  if (title) {
    const summaryGot = await getJson(
      "wikipedia",
      `${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    );
    if (summaryGot.kind === "error") {
      definitive = false;
    } else if (summaryGot.kind === "ok") {
      const s = summaryGot.body as {
        extract?: string;
        content_urls?: { desktop?: { page?: string } };
      };
      if (s.extract) {
        summary = s.extract;
        wikipediaUrl =
          s.content_urls?.desktop?.page ??
          `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
      }
    }
    // 'missing' = the article is gone: an answer, stays definitive
  }

  return { summary, wikipediaUrl, definitive };
}
