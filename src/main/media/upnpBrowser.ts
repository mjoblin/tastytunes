// UPnP media browsing for the Library screen. Server discovery rides the
// streamer (`GET /smoip/system/upnp` lists every UPnP device it knows —
// including itself when USB storage is attached); browsing is plain
// ContentDirectory:1 SOAP. Everything happens here in the main process: the
// renderer only ever sees typed MediaNodes, and DIDL-Lite never leaves this
// file except encoded inside /smoip/queue/add (queue writes) or a JSON body
// (action=PRESET — preset saves). Streamer-directed SMOIP traffic is
// unlogged (it has its own console); media-server traffic logs as 'upnp'.
import {
  LARGE_QUEUE_TRACKS,
  type MediaNode,
  type MediaQueueAction,
  type MediaServerInfo,
  usbServer,
} from "@shared/model";
import { LARGE_QUEUE_TOKEN } from "@shared/ipc";
import { asArray, didlToNodes, parser, text } from "./didl";
import { loggedFetch } from "../netlog";

const PAGE_SIZE = 5000; // the streamer's own server ignores RequestedCount=0

interface ServerEntry extends MediaServerInfo {
  controlUrl: string;
  /** Raw SearchCaps: "*" (anything), a CSV of properties, or "" (no search). */
  searchCaps: string;
  /** The description URL's hostname and origin — what an art URL names. */
  host: string;
  origin: string;
}

let servers = new Map<string, ServerEntry>();
// Per-node listing cache, session only. Streamer-USB ids rot across standby;
// a failed browse falls back to re-walking the breadcrumb titles from root.
const nodeCache = new Map<string, MediaNode[]>();

/**
 * NOT ANSWERING IS NOT NOT FOUND (2026-09-16, the user's Evo). A server that
 * refuses an object ("no such object", a SOAP 701 fault, a 4xx) is answering:
 * the id is gone and a heal is right. A server that times out, resets the
 * connection or refuses it is NOT answering, and every heal the app used to
 * run on that silence — the breadcrumb re-walk, the index revalidation's
 * rebuild — was more traffic into a server already down. The streamer's own
 * media server took the whole device with it: its ContentDirectory and the
 * control socket are one application, and a re-walk of the stick beside a
 * reconnect's burst restarted it, four times in a row. So every SOAP answer
 * is one of three things, and only "missing" heals.
 */
export type Miss = "missing" | "unreachable";
const MISSING_RE = /no such object|<errorCode>\s*701\s*<\/errorCode>/i;

// ---------------------------------------------------- the device's own lane
//
// The streamer's own ContentDirectory (USB storage) gets ONE lane: requests to
// it run one at a time, the screen's ahead of a walk's, and a walk paced a
// little wider. A request that dies on the wire is the device's SILENCE: the
// lane pauses, the request that died waits for the device and goes again
// once, the callers behind it wait too, and a CANARY (one counter read) asks
// after two seconds, then four, then eight, up to the cap, whether the device
// answers again — so a replug, whose silence lasts a second or two, reads as a
// slow load and not as an error page (the hard 30 s wall it replaces turned a
// routine replug into "Couldn't browse this library", 2026-09-16). Past the
// cap the waiting callers are failed and newcomers fail at once, while the
// canary keeps asking; a reconnect ends the pause outright.
const DEVICE_GAP_MS = 10;
// a walk sits BEHIND the screen's requests, and that ordering is its pacing: the
// evening's probes showed pace itself does not trouble the device, and a stick of a
// few thousand folders must still index within minutes (25 ms cost the harness's
// 450-container walk its 30 s window)
const DEVICE_WALK_GAP_MS = 10;
const DEVICE_CANARY_MS = 2000;
// the cap, shortened by the harness (TASTYTUNES_DEVICE_COOL_MS) so a suite can
// watch a silence open and close
const DEVICE_COOL_MS = Number(process.env["TASTYTUNES_DEVICE_COOL_MS"] ?? 30_000);

interface LaneJob {
  run: () => Promise<void>;
  background: boolean;
  /** How many times the request has died on the wire: once is a pooled connection the
   *  device had dropped (a fresh one goes at once), twice is the device's silence
   *  (it waits for the canary and goes again), three times is the answer. */
  attempts: number;
  fail: (e: Error) => void;
}
const laneFront: LaneJob[] = [];
const laneBack: LaneJob[] = [];
let lanePumping = false;
/** When the device stopped answering; 0 while it answers. */
let deviceDownSince = 0;
let deviceControlUrl: string | null = null;
let canaryTimer: NodeJS.Timeout | null = null;
let canaryWait = DEVICE_CANARY_MS;

/** Whether a server rides the lane: the device's USB server, by its shape
 *  (usbServer in shared/model). In the harness every mock server sits on the
 *  streamer's address, so the address alone would have laned them all. */
const laned = (entry: ServerEntry): boolean => usbServer(entry);

/** True while the device's own media server is silent and the lane waits on the canary. */
export function deviceCooling(): boolean {
  return deviceDownSince !== 0;
}

/** The lane's state, for the harness and the diagnostics: whether the device is
 *  silent, what waits, whether the canary is armed. */
export function deviceLaneState(): {
  down: boolean;
  front: number;
  back: number;
  pumping: boolean;
  canary: boolean;
} {
  return {
    down: deviceDownSince !== 0,
    front: laneFront.length,
    back: laneBack.length,
    pumping: lanePumping,
    canary: canaryTimer != null,
  };
}

/** A reconnect: the device announced itself, so the pause ends and the listing
 *  memo is dropped; the fresh session starts on facts, through the lane. */
export function deviceLaneReset(): void {
  deviceDownSince = 0;
  if (canaryTimer) {
    clearTimeout(canaryTimer);
    canaryTimer = null;
  }
  listing = null;
  void pumpLane();
}

class DeviceCoolingError extends Error {
  constructor() {
    super("the streamer's media server is not answering; holding off");
  }
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const laneLog = (msg: string): void => {
  if (process.env["TASTYTUNES_LANE_DEBUG"]) console.log(`[lane] ${msg}`);
};

function laneSilence(): void {
  if (deviceDownSince === 0) {
    deviceDownSince = Date.now();
    canaryWait = DEVICE_CANARY_MS;
    console.log(
      `[upnp] the streamer's media server is not answering; asking again in ${canaryWait / 1000} s`,
    );
  }
  scheduleCanary();
}

function scheduleCanary(): void {
  if (canaryTimer) return;
  canaryTimer = setTimeout(() => {
    canaryTimer = null;
    void canary();
  }, canaryWait);
}

/** One counter read, straight to the device: answered, the lane resumes; not, the
 *  wait doubles, and past the cap the callers waiting are failed. */
async function canary(): Promise<void> {
  if (deviceDownSince === 0) return;
  let ok = false;
  if (deviceControlUrl) {
    try {
      const res = await loggedFetch("upnp", deviceControlUrl, {
        method: "POST",
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#GetSystemUpdateID"',
        },
        body: `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><u:GetSystemUpdateID xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"></u:GetSystemUpdateID></s:Body>
</s:Envelope>`,
        signal: AbortSignal.timeout(4000),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
  }
  if (deviceDownSince === 0) return; // a reconnect ended the pause meanwhile
  if (ok) {
    console.log("[upnp] the streamer's media server answers again");
    deviceDownSince = 0;
    void pumpLane();
    return;
  }
  if (Date.now() - deviceDownSince > DEVICE_COOL_MS) {
    for (const job of laneFront.splice(0)) job.fail(new DeviceCoolingError());
    for (const job of laneBack.splice(0)) job.fail(new DeviceCoolingError());
  }
  canaryWait = Math.min(canaryWait * 2, DEVICE_COOL_MS);
  scheduleCanary();
}

async function pumpLane(): Promise<void> {
  if (lanePumping) return;
  lanePumping = true;
  try {
    while (deviceDownSince === 0) {
      const job = laneFront.shift() ?? laneBack.shift();
      if (!job) break;
      laneLog(
        `run ${job.background ? "back" : "front"} (front ${laneFront.length}, back ${laneBack.length})`,
      );
      await job.run();
      laneLog("ran");
      await pause(job.background ? DEVICE_WALK_GAP_MS : DEVICE_GAP_MS);
    }
  } finally {
    lanePumping = false;
  }
}

interface CdInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/** A ContentDirectory fetch. Other servers: straight through, with the
 *  timeout. The device's USB server: through the lane, the timeout starting
 *  when the request actually goes out (a wait in the lane is not the device's
 *  silence); a throw on the wire pauses the lane for the canary. */
function cdFetch(
  url: string,
  init: CdInit,
  lane: { on: boolean; background?: boolean },
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const send = (): Promise<Response> =>
    loggedFetch("upnp", url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  if (!lane.on) return send();
  deviceControlUrl = url;
  if (deviceDownSince !== 0 && Date.now() - deviceDownSince > DEVICE_COOL_MS)
    return Promise.reject(new DeviceCoolingError());
  return new Promise<Response>((resolve, reject) => {
    const job: LaneJob = {
      background: lane.background === true,
      attempts: 0,
      fail: reject,
      run: async () => {
        for (;;) {
          try {
            laneLog("send");
            resolve(await send());
            laneLog("sent");
            return;
          } catch (e) {
            job.attempts++;
            laneLog(`died ${String(e)} (attempt ${job.attempts})`);
            // the app's first request after a replug or a restart lands on a pooled
            // connection the device had dropped and dies at once (the dev log of
            // 2026-09-16: every reconnect's first request "not answering" while the
            // device answered every probe): one more go on a fresh connection before
            // this counts as silence
            if (job.attempts === 1) continue;
            if (job.attempts === 2) {
              // the device is silent: the request waits at the front for the canary
              // to hear it and goes again once
              laneFront.unshift(job);
              laneSilence();
              return;
            }
            laneSilence();
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }
        }
      },
    };
    (job.background ? laneBack : laneFront).push(job);
    laneLog(`queued ${job.background ? "back" : "front"}; pumping ${lanePumping}`);
    void pumpLane();
  });
}

/** How a non-ok answer reads. The device's own server refuses a rotted id in
 *  words (the mock says "no such object"; a 4xx is a refusal too), and a bare
 *  5xx from it is a server under strain, not a verdict on the object. Any
 *  other server's error answer is the answer. */
function classify(status: number, body: string, device: boolean): Miss {
  if (MISSING_RE.test(body) || (status >= 400 && status < 500)) return "missing";
  return device ? "unreachable" : "missing";
}

// ------------------------------------------------------------ server registry

// One listing per burst: the connect hook, the Library's mount and a
// reconnect's remount all ask within the same second, and each listing is a
// description fetch plus a capability call per server — into the device's own
// server among them. A listing in hand this recent is the answer.
const LISTING_MEMO_MS = 5000;
let listing: { host: string; at: number; run: Promise<MediaServerInfo[]> } | null = null;

export async function refreshServers(host: string): Promise<MediaServerInfo[]> {
  if (listing && listing.host === host && Date.now() - listing.at < LISTING_MEMO_MS)
    return listing.run;
  const run = listServers(host);
  listing = { host, at: Date.now(), run };
  run.catch(() => {
    if (listing?.run === run) listing = null;
  });
  return run;
}

/** The server whose description lives where this art URL does: the queue's
 *  and play state's art names the server that is playing (Asset's own port,
 *  the device's own address), so the same content on two servers resolves to
 *  the one that is audible. Exact origin first, then the host alone (the
 *  device serves art on :80 and its ContentDirectory on another port). */
export function serverUdnForArt(artUrl: string | null | undefined): string | null {
  if (!artUrl) return null;
  let u: URL;
  try {
    u = new URL(artUrl);
  } catch {
    return null;
  }
  const all = [...servers.values()];
  return (
    all.find((s) => s.origin === u.origin)?.udn ??
    all.find((s) => s.host === u.hostname)?.udn ??
    null
  );
}

async function listServers(host: string): Promise<MediaServerInfo[]> {
  const res = await fetch(`http://${host}/smoip/system/upnp`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`system/upnp -> HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: {
      devices?: Array<{
        model?: string;
        name?: string;
        manufacturer?: string;
        udn?: string;
        description_url?: string;
      }>;
    };
  };

  const streamerIp = host.split(":")[0];
  const next = new Map<string, ServerEntry>();
  for (const dev of body.data?.devices ?? []) {
    if (!dev.udn || !dev.description_url) continue;
    let where: URL;
    try {
      where = new URL(dev.description_url);
    } catch {
      continue;
    }
    const device = where.hostname === streamerIp;
    const controlUrl = await contentDirectoryControlUrl(dev.description_url);
    if (!controlUrl) continue; // no ContentDirectory — a renderer-only device
    const searchCaps = await getSearchCaps(controlUrl);
    next.set(dev.udn, {
      udn: dev.udn,
      name: dev.name ?? dev.model ?? "Media server",
      model: dev.model ?? null,
      isStreamer: device,
      searchable: searchCaps.length > 0,
      searchCaps,
      controlUrl,
      host: where.hostname,
      origin: where.origin,
    });
  }
  servers = next;
  nodeCache.clear();
  return [...next.values()].map(({ udn, name, model, isStreamer, searchable }) => ({
    udn,
    name,
    model,
    isStreamer,
    searchable,
  }));
}

/** GetSearchCapabilities: "*" = anything, CSV = specific properties, "" = none. */
async function getSearchCaps(controlUrl: string): Promise<string> {
  try {
    const res = await loggedFetch("upnp", controlUrl, {
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#GetSearchCapabilities"',
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><u:GetSearchCapabilities xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"></u:GetSearchCapabilities></s:Body>
</s:Envelope>`,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const doc = parser.parse(await res.text()) as {
      Envelope?: { Body?: { GetSearchCapabilitiesResponse?: { SearchCaps?: unknown } } };
    };
    return text(doc.Envelope?.Body?.GetSearchCapabilitiesResponse?.SearchCaps)?.trim() ?? "";
  } catch {
    return "";
  }
}

async function contentDirectoryControlUrl(descriptionUrl: string): Promise<string | null> {
  try {
    const res = await loggedFetch("upnp", descriptionUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const doc = parser.parse(await res.text()) as Record<string, never>;
    const device = (doc as { root?: { device?: unknown } }).root?.device as
      Record<string, unknown> | undefined;
    if (!device) return null;
    const services = asArray(
      (device.serviceList as { service?: unknown } | undefined)?.service as
        Record<string, unknown> | Array<Record<string, unknown>> | undefined,
    );
    const cd = services.find((s) => String(s.serviceType ?? "").includes("ContentDirectory"));
    const control = cd && text(cd.controlURL);
    return control ? new URL(control, descriptionUrl).toString() : null;
  } catch {
    return null;
  }
}

async function entryFor(host: string, serverUdn: string): Promise<ServerEntry> {
  if (!servers.has(serverUdn)) await refreshServers(host);
  const entry = servers.get(serverUdn);
  if (!entry) throw new Error("media server not found");
  return entry;
}

// ------------------------------------------------------------------ SOAP Browse

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function soapEnvelope(objectId: string, flag: string, start: number, count: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <ObjectID>${xmlEscape(objectId)}</ObjectID>
      <BrowseFlag>${flag}</BrowseFlag>
      <Filter>*</Filter>
      <StartingIndex>${start}</StartingIndex>
      <RequestedCount>${count}</RequestedCount>
      <SortCriteria></SortCriteria>
    </u:Browse>
  </s:Body>
</s:Envelope>`;
}

/** One Browse: the answer, or which kind of miss it was (see Miss). */
async function soapBrowse(
  entry: ServerEntry,
  objectId: string,
  flag: "BrowseDirectChildren" | "BrowseMetadata",
  start = 0,
  count = PAGE_SIZE,
  background = false,
): Promise<{ didl: string; returned: number; total: number } | Miss> {
  let res: Response;
  let body: string;
  try {
    res = await cdFetch(
      entry.controlUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"',
        },
        body: soapEnvelope(objectId, flag, start, count),
        timeoutMs: 15_000,
      },
      { on: laned(entry), background },
    );
    body = await res.text();
  } catch {
    return "unreachable";
  }
  if (!res.ok) return classify(res.status, body, entry.isStreamer);
  const doc = parser.parse(body) as {
    Envelope?: {
      Body?: {
        BrowseResponse?: { Result?: unknown; NumberReturned?: number; TotalMatches?: number };
      };
    };
  };
  const br = doc.Envelope?.Body?.BrowseResponse;
  const didl = text(br?.Result);
  if (didl == null) return classify(res.status, body, entry.isStreamer);
  return {
    didl,
    returned: Number(br?.NumberReturned ?? 0),
    total: Number(br?.TotalMatches ?? 0),
  };
}

async function browseChildren(
  entry: ServerEntry,
  objectId: string,
  background = false,
): Promise<MediaNode[] | Miss> {
  const first = await soapBrowse(entry, objectId, "BrowseDirectChildren", 0, PAGE_SIZE, background);
  if (typeof first === "string") return first;
  let nodes = didlToNodes(first.didl);
  // Page through folders bigger than one response (and servers that cap it).
  while (nodes.length < first.total) {
    const more = await soapBrowse(
      entry,
      objectId,
      "BrowseDirectChildren",
      nodes.length,
      PAGE_SIZE,
      background,
    );
    if (typeof more === "string") break;
    const add = didlToNodes(more.didl);
    if (add.length === 0) break;
    nodes = nodes.concat(add);
  }
  return nodes;
}

export async function browse(
  host: string,
  serverUdn: string,
  objectId: string | null,
  titlePath: string[],
): Promise<MediaNode[]> {
  const entry = await entryFor(host, serverUdn);
  const id = objectId ?? "0";
  const key = `${serverUdn}|${id}`;
  const cached = nodeCache.get(key);
  if (cached) return cached;

  let nodes = await browseChildren(entry, id);
  if (nodes === "missing" && objectId != null) {
    // Stale id (streamer-USB ids rot across standby) — drop this server's
    // cache and re-walk the breadcrumb titles from the root. Only for an id
    // the server REFUSED: a server that is not answering gets no re-walk.
    for (const k of [...nodeCache.keys()]) if (k.startsWith(`${serverUdn}|`)) nodeCache.delete(k);
    nodes = await rewalk(entry, titlePath);
  }
  if (typeof nodes === "string") throw new Error("browse failed");
  nodeCache.set(key, nodes);
  return nodes;
}

async function rewalk(entry: ServerEntry, titlePath: string[]): Promise<MediaNode[] | Miss> {
  let id = "0";
  for (const title of titlePath) {
    const kids = await browseChildren(entry, id);
    if (typeof kids === "string") return kids;
    const next = kids.find((k) => k.isContainer && k.title === title);
    if (!next) return "missing";
    id = next.id;
  }
  return browseChildren(entry, id);
}

// ----------------------------------------------------------------- Search

const SEARCH_MAX = 500;

async function searchScope(
  entry: ServerEntry,
  criteria: string,
): Promise<{ items: MediaNode[]; total: number } | null> {
  return searchPageRaw(entry, criteria, 0, SEARCH_MAX);
}

async function searchPageRaw(
  entry: ServerEntry,
  criteria: string,
  start: number,
  count: number,
): Promise<{ items: MediaNode[]; total: number } | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <u:Search xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <ContainerID>0</ContainerID>
      <SearchCriteria>${xmlEscape(criteria)}</SearchCriteria>
      <Filter>*</Filter>
      <StartingIndex>${start}</StartingIndex>
      <RequestedCount>${count}</RequestedCount>
      <SortCriteria></SortCriteria>
    </u:Search>
  </s:Body>
</s:Envelope>`;
  try {
    const res = await cdFetch(
      entry.controlUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Search"',
        },
        body,
        timeoutMs: 20_000,
      },
      { on: laned(entry) },
    );
    if (!res.ok) return null;
    const doc = parser.parse(await res.text()) as {
      Envelope?: {
        Body?: { SearchResponse?: { Result?: unknown; TotalMatches?: number } };
      };
    };
    const sr = doc.Envelope?.Body?.SearchResponse;
    const didl = text(sr?.Result);
    if (didl == null) return null;
    return { items: didlToNodes(didl), total: Number(sr?.TotalMatches ?? 0) };
  } catch {
    return null;
  }
}

/**
 * Whole-library search. Probed grammar reality (Asset): criteria MUST be
 * scoped with `upnp:class derivedfrom …` to return anything, OR works
 * WITHIN a scope but not across scoped groups — so run one search per
 * entity kind (albums, artists, tracks) and merge, deduped by id. Field
 * clauses only reference properties the server DECLARES searchable
 * (SearchCaps "*" = all; a CSV limits us — e.g. a title-only server still
 * gets title search instead of silent zero-result queries).
 */
export async function search(
  host: string,
  serverUdn: string,
  query: string,
): Promise<{ items: MediaNode[]; total: number }> {
  const entry = await entryFor(host, serverUdn);
  const phrase = query.replace(/["\\]/g, ""); // criteria-grammar safe

  const caps = entry.searchCaps;
  const has = (prop: string): boolean =>
    caps === "*" || caps.split(",").some((c) => c.trim() === prop);
  const orClause = (props: string[]): string | null => {
    const usable = props.filter(has);
    if (usable.length === 0) return null;
    const inner = usable.map((p) => `${p} contains "${phrase}"`).join(" or ");
    return usable.length > 1 ? `(${inner})` : inner;
  };

  const scopes = [
    {
      cls: "object.container.album",
      leaf: "object.container.album.musicAlbum",
      fields: orClause(["dc:title", "upnp:artist"]),
    },
    {
      cls: "object.container.person",
      leaf: "object.container.person.musicArtist",
      fields: orClause(["dc:title"]),
    },
    {
      cls: "object.item.audioItem",
      leaf: null,
      fields: orClause(["dc:title", "upnp:artist", "upnp:album"]),
    },
  ].filter((s): s is { cls: string; leaf: string | null; fields: string } => s.fields != null);
  if (scopes.length === 0) throw new Error("server declares no searchable text properties");

  const results = [];
  for (const s of scopes) {
    const r = await searchScope(entry, `upnp:class derivedfrom "${s.cls}" and ${s.fields}`);
    // Asset generalizes classes in Search results to the scoped base class
    // (an album browses as …album.musicAlbum but searches as bare
    // object.container.album) — normalize to the specific leaf so the
    // vividness/chips/album-header rules behave exactly like browsing.
    if (r && s.leaf != null) {
      const leaf = s.leaf;
      const tail = leaf.split(".").pop() as string;
      r.items = r.items.map((n) =>
        n.isContainer && !n.upnpClass.includes(tail) ? { ...n, upnpClass: leaf } : n,
      );
    }
    results.push(r);
  }
  if (results.every((r) => r == null)) throw new Error("search failed");

  const seen = new Set<string>();
  const items: MediaNode[] = [];
  let total = 0;
  for (const r of results) {
    if (!r) continue;
    total += r.total;
    for (const node of r.items) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (items.length < SEARCH_MAX) items.push(node);
    }
  }
  return { items, total };
}

// ------------------------------------------------------ index-crawler primitives

/** One raw-criteria Search page — the index crawler's fast path. */
export async function searchPage(
  host: string,
  serverUdn: string,
  criteria: string,
  start: number,
  count: number,
): Promise<{ items: MediaNode[]; total: number } | null> {
  const entry = await entryFor(host, serverUdn);
  return searchPageRaw(entry, criteria, start, count);
}

/** Direct children of one container (paged internally) — the browse-crawl
 *  path. A walk stops on "unreachable" (the server is not answering; the index
 *  it has stands) and skips a "missing" container. */
export async function browseChildrenOf(
  host: string,
  serverUdn: string,
  objectId: string,
  opts: { background?: boolean } = {},
): Promise<MediaNode[] | Miss> {
  const entry = await entryFor(host, serverUdn);
  return browseChildren(entry, objectId, opts.background === true);
}

/** Whether ONE object still answers: "present", "missing" (the server refused
 *  the id — a rotted one) or "unreachable" (the server is not answering, which
 *  says nothing about the id). The index revalidation's probe. */
export async function probeObject(
  host: string,
  serverUdn: string,
  objectId: string,
): Promise<"present" | Miss> {
  let entry: ServerEntry;
  try {
    entry = await entryFor(host, serverUdn);
  } catch {
    return "unreachable";
  }
  const r = await soapBrowse(entry, objectId, "BrowseMetadata", 0, 1);
  if (typeof r === "string") return r;
  return didlToNodes(r.didl)[0] ? "present" : "missing";
}

/**
 * ONE object's own metadata (BrowseMetadata), parsed like everything else —
 * the live fallback for the Info modal when a list holds a server + id the
 * index doesn't (a Browse-only server before its build). Null on any miss.
 */
export async function browseMetadataNode(
  host: string,
  serverUdn: string,
  objectId: string,
): Promise<MediaNode | null> {
  try {
    const entry = await entryFor(host, serverUdn);
    const r = await soapBrowse(entry, objectId, "BrowseMetadata", 0, 1);
    if (typeof r === "string") return null;
    return didlToNodes(r.didl)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * EXPERIMENT (0.7 exploration): the raw audio res URL for one object. The
 * parser deliberately drops res URLs (they are ephemeral — resolve fresh at
 * use, never store), so this reads the raw DIDL from a BrowseMetadata and
 * takes the first res whose protocolInfo says audio. Null on any miss.
 */
export async function audioResUrl(
  host: string,
  serverUdn: string,
  objectId: string,
): Promise<string | null> {
  try {
    const entry = await entryFor(host, serverUdn);
    const r = await soapBrowse(entry, objectId, "BrowseMetadata", 0, 1);
    if (typeof r === "string") return null;
    const m = /<res\b[^>]*audio[^>]*>\s*(http[^<\s]+)\s*<\/res>/i.exec(r.didl);
    return m ? m[1].replace(/&amp;/g, "&") : null;
  } catch {
    return null;
  }
}

/**
 * The server's SystemUpdateID — a MANDATORY ContentDirectory action, so even
 * search-less servers answer it. Bumps whenever the library changes; the one
 * cheap question that keeps the media index honest.
 */
export async function getSystemUpdateID(host: string, serverUdn: string): Promise<number | null> {
  try {
    const entry = await entryFor(host, serverUdn);
    const res = await cdFetch(
      entry.controlUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#GetSystemUpdateID"',
        },
        body: `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><u:GetSystemUpdateID xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"></u:GetSystemUpdateID></s:Body>
</s:Envelope>`,
        timeoutMs: 10_000,
      },
      { on: laned(entry) },
    );
    if (!res.ok) return null;
    const doc = parser.parse(await res.text()) as {
      Envelope?: { Body?: { GetSystemUpdateIDResponse?: { Id?: unknown } } };
    };
    const id = text(doc.Envelope?.Body?.GetSystemUpdateIDResponse?.Id);
    return id == null ? null : Number(id);
  } catch {
    return null;
  }
}

// --------------------------------------------------------- queue/preset writes

async function metadataDidl(entry: ServerEntry, objectId: string): Promise<string> {
  const r = await soapBrowse(entry, objectId, "BrowseMetadata", 0, 200);
  if (typeof r === "string") throw new Error("could not fetch item metadata");
  return r.didl;
}

/**
 * THE LARGE-QUEUE GUARD (2026-09-10). Every surface reaches the streamer
 * through queueAdd, the MCP too, and a container verb queues whatever the
 * container lists: Play from here on a search scope once queued 2,528 tracks
 * on the user's Evo (2026-09-04). A container over LARGE_QUEUE_TRACKS refuses
 * with this unless the caller confirmed; the renderer's tt wrapper asks and
 * calls again, an agent is told to ask the user. The count is the container's
 * direct listing (TotalMatches of a one-item Browse, one extra round trip per
 * container verb); a server that reports no total is not guarded.
 */
export class LargeQueueError extends Error {
  constructor(readonly tracks: number) {
    super(`${LARGE_QUEUE_TOKEN}:${tracks}`);
  }
}

export async function queueAdd(
  host: string,
  serverUdn: string,
  objectId: string,
  action: MediaQueueAction,
  playFromId?: string,
  opts: { confirmLarge?: boolean } = {},
): Promise<void> {
  const entry = await entryFor(host, serverUdn);
  const didl = await metadataDidl(entry, objectId);
  if (!opts.confirmLarge && /<container[\s>]/.test(didl)) {
    const probe = await soapBrowse(entry, objectId, "BrowseDirectChildren", 0, 1);
    if (typeof probe !== "string" && probe.total > LARGE_QUEUE_TRACKS)
      throw new LargeQueueError(probe.total);
  }
  const udn = serverUdn.replace(/^uuid:/, "");
  // The endpoint is encoding-sensitive: EVERY special character in the DIDL
  // must be percent-encoded (vibin's hard-won quote(didl, safe="") lesson).
  let url =
    `http://${host}/smoip/queue/add?action=${action}` +
    `&didl=${encodeURIComponent(didl)}&server_udn=${encodeURIComponent(udn)}`;
  if (action === "PLAY_FROM_HERE" && playFromId) {
    url += `&play_from_id=${encodeURIComponent(playFromId)}`;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`queue/add -> HTTP ${res.status}`);
}

export async function presetSave(
  host: string,
  serverUdn: string,
  objectId: string,
  slot: number,
): Promise<void> {
  if (slot < 1 || slot > 99) throw new Error(`preset slot must be 1-99, got ${slot}`);
  const entry = await entryFor(host, serverUdn);
  const didl = await metadataDidl(entry, objectId);
  const res = await fetch(`http://${host}/smoip/queue/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "PRESET",
      preset: slot,
      server_udn: serverUdn.replace(/^uuid:/, ""),
      type: "didl",
      didl,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`queue/add PRESET -> HTTP ${res.status}`);
}
