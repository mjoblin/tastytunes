// Internet-radio directory lookups via radio-browser.info — community-run,
// keyless, no shipped secrets (the same rule that vetoed Last.fm). They ask
// only for an identifying User-Agent, which is why this lives in the main
// process (renderer fetch can't set one, and the renderer CSP blocks external
// hosts anyway). Searches are live (no cache): the directory ranks by
// popularity and station health server-side, and results should reflect it.
// Deliberately NOT sent: the per-station "click" ping the directory offers —
// it would report listening activity to a third party; revisit only as an
// opt-in (privacy table in the README is a promise).
import type { RadioStation } from "@shared/model";
import { loggedFetch, USER_AGENT } from "../netlog";
import { getSettings } from "../data/persist";
import { nameKey } from "@shared/keys";

// TASTYTUNES_RADIO_URL lets test harnesses point lookups at a local server.
// all.api.radio-browser.info is the project's round-robin DNS over its
// mirrors — fine for interactive use like ours.
const BASE = process.env["TASTYTUNES_RADIO_URL"] ?? "https://all.api.radio-browser.info/json";
const LIMIT = 60;

interface ApiStation {
  stationuuid: string;
  name: string;
  url_resolved: string;
  url: string;
  favicon: string;
  homepage: string;
  tags: string;
  country: string;
  codec: string;
  bitrate: number;
  clickcount?: number;
  countrycode?: string;
  language?: string;
  votes?: number;
}

function toStation(s: ApiStation): RadioStation | null {
  const url = s.url_resolved || s.url;
  if (!url || !s.name?.trim()) return null;
  return {
    uuid: s.stationuuid,
    name: s.name.trim(),
    url,
    favicon: s.favicon || null,
    homepage: s.homepage || null,
    tags: s.tags ?? "",
    country: s.country ?? "",
    codec: s.codec ?? "",
    bitrate: s.bitrate ?? 0,
    countryCode: s.countrycode ?? "",
    language: s.language ?? "",
    votes: s.votes ?? 0,
  };
}

/**
 * THE gate for every outbound directory call. Placed at the source rather than
 * at each caller so "off means no requests, ever" holds by construction — the
 * Radio screen, unified search and the MCP search_radio tool all funnel here,
 * and a future caller inherits the promise without knowing about it.
 */
function directoryAllowed(): boolean {
  return getSettings().radioDirectory !== false;
}

async function fetchRaw(path: string): Promise<ApiStation[]> {
  if (!directoryAllowed()) return [];
  try {
    const res = await loggedFetch("radio-browser", `${BASE}${path}`, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    return (await res.json()) as ApiStation[];
  } catch {
    return [];
  }
}

/** Map + dedupe (the directory holds many duplicate registrations of one stream). */
function toStations(raw: ApiStation[]): RadioStation[] {
  const out: RadioStation[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    const st = toStation(s);
    if (st && !seen.has(st.url)) {
      seen.add(st.url);
      out.push(st);
    }
  }
  return out;
}

const stations = async (path: string): Promise<RadioStation[]> => toStations(await fetchRaw(path));

/** Name search, most-listened first, broken stations filtered by the directory. */
export function radioSearch(query: string): Promise<RadioStation[]> {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  const params = new URLSearchParams({
    name: q,
    limit: String(LIMIT),
    hidebroken: "true",
    order: "clickcount",
    reverse: "true",
  });
  return stations(`/stations/search?${params.toString()}`);
}

/**
 * A SEARCH FOR AN AGENT (0.16.0: fifteen results, no paging, no bitrate, the country's full
 * name on every row): a name, a tag or both, narrowed by country (a two-letter code, or a name),
 * language and a lowest bitrate, sorted by listeners, votes or bitrate (how a listener who cares
 * about sound picks the best stream of a station), a page at a time. The directory does the
 * narrowing, so a page is a page of what was asked.
 */
export function radioFind(o: {
  name?: string;
  tag?: string;
  country?: string;
  language?: string;
  bitrateMin?: number;
  order: "clickcount" | "votes" | "bitrate";
  limit: number;
  offset: number;
}): Promise<RadioStation[]> {
  const params = new URLSearchParams({
    limit: String(o.limit),
    offset: String(o.offset),
    hidebroken: "true",
    order: o.order,
    reverse: "true",
  });
  if (o.name) params.set("name", o.name);
  if (o.tag) {
    params.set("tag", o.tag);
    params.set("tagExact", "true");
  }
  if (o.country) {
    if (/^[a-z]{2}$/i.test(o.country.trim()))
      params.set("countrycode", o.country.trim().toUpperCase());
    else params.set("country", o.country.trim());
  }
  if (o.language) params.set("language", nameKey(o.language));
  if (o.bitrateMin) params.set("bitrateMin", String(o.bitrateMin));
  return stations(`/stations/search?${params.toString()}`);
}

/** The directory's most-listened stations — the screen's default rail. */
export function radioTop(): Promise<RadioStation[]> {
  return stations(`/stations/topclick/${LIMIT}?hidebroken=true`);
}

/**
 * Stations for a curated category — one popularity query per tag (the
 * directory's tagList means ALL-of, not any-of), merged, deduped, re-ranked
 * by listener count so the union reads as one rail.
 */
export async function radioByTags(tags: string[]): Promise<RadioStation[]> {
  const perTag = await Promise.all(
    tags.map((tag) => {
      const params = new URLSearchParams({
        tag,
        tagExact: "true",
        limit: "40",
        hidebroken: "true",
        order: "clickcount",
        reverse: "true",
      });
      return fetchRaw(`/stations/search?${params.toString()}`);
    }),
  );
  const merged = perTag.flat().sort((a, b) => (b.clickcount ?? 0) - (a.clickcount ?? 0));
  return toStations(merged).slice(0, LIMIT);
}
