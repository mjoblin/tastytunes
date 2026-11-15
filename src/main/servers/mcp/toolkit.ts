import { z, type ZodRawShape } from "zod";
import { type MenuCommand, type Snapshot } from "@shared/ipc";
import {
  type AppSettings,
  type ConnectionState,
  type MediaIndexPools,
  type MediaNode,
  type MediaQueueAction,
  type PlaylistItem,
  type Schedule,
} from "@shared/model";
import { type Favorite, heartOf, heartPeersFrom, resumeRun } from "@shared/model";
import { audioCaps, type ZonePlayState } from "@shared/smoip";
import type { DeviceManager } from "../../device/deviceManager";
import { getSettings } from "../../data/persist";
import { pools as indexPools, revalidate } from "../../media/mediaIndex";
import { bestInIndexes, indexFinder } from "../../media/resolveContent";
import { nameKey, searchFold } from "@shared/keys";

// The MCP bridge's TOOLKIT (2026-09-13, the bridge split: 74 tool implementations
// had sat in one 2,400-line member): the tool result and implementation shapes,
// the ok/err results, the streamer argument the history tools share, the pure
// helpers the tools reach, and the context a tool module takes from the bridge.
// The tools themselves live beside this file, one module per family, joined in
// the bridge's toolImpls.

export interface ToolResult {
  /** Text, or an image (get_album_art, 2026-09-14: base64 bytes and their type, the MCP
   *  image content block, which clients that render pictures show). */
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface ToolImpl {
  inputSchema?: ZodRawShape;
  handler(args: Record<string, unknown>): Promise<ToolResult> | ToolResult;
}

/**
 * A tool whose handler reads its arguments typed by its own schema (0.11.0 sweep): the SDK
 * validates a call's arguments against inputSchema before the handler runs, so the types
 * are what arrives, and the handlers lost their `as string` casts. A tool without a schema
 * takes no arguments.
 */
export function defineTool<S extends ZodRawShape>(tool: {
  inputSchema: S;
  handler(args: z.infer<z.ZodObject<S>>): Promise<ToolResult> | ToolResult;
}): ToolImpl;
export function defineTool(tool: { handler(): Promise<ToolResult> | ToolResult }): ToolImpl;
export function defineTool(tool: ToolImpl): ToolImpl {
  return tool;
}

/** A tool's answer: a sentence as it is, anything else as compact JSON (0.16.0: an indent of two
 *  was a quarter to two fifths of every answer, and an agent reads neither). */
export const ok = (payload: unknown): ToolResult => ({
  content: [
    { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) },
  ],
});
export const err = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * ONE TIME FORMAT (0.16.0): a moment as every tool says it, local time with its offset
 * ("2026-11-14T21:55:03-08:00"), in the offset it happened at when the record kept one (a line's
 * tzOffsetMin, as Date's getTimezoneOffset: minutes west of UTC), else this machine's. Before, the
 * record's times came back in UTC while the days an agent asks for are local, and two answers gave
 * epoch milliseconds.
 */
export function localTime(ms: number, tzOffsetMin?: number | null): string {
  const tz = tzOffsetMin ?? new Date(ms).getTimezoneOffset();
  const shifted = new Date(ms - tz * 60_000).toISOString().slice(0, 19);
  const off = Math.abs(tz);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${shifted}${tz <= 0 ? "+" : "-"}${p(Math.floor(off / 60))}:${p(off % 60)}`;
}
/** localTime for a moment that may be missing (0, null: never). */
export const localTimeOrNull = (ms: number | null | undefined): string | null =>
  ms != null && ms > 0 ? localTime(ms) : null;

/** Brief rows by default, every field on request (0.16.0, the rows an agent reads most). */
export const DETAIL_ARG = z
  .enum(["brief", "full"])
  .optional()
  .describe("Default 'brief', the fields an answer needs; 'full' adds every stored field.");

/**
 * STRICT ARGUMENTS (0.16.0): a tool's arguments as a strict object, so an argument the tool does
 * not take is an error naming the ones it does. Before, an unknown argument was dropped and the
 * call answered as if it were absent: list_tracks with a query returned the whole library.
 */
export function strictInput(
  name: string,
  shape: ZodRawShape = {},
): z.ZodObject<ZodRawShape, z.core.$strict> {
  const names = Object.keys(shape);
  return z.strictObject(shape, {
    error: (iss) =>
      iss.code === "unrecognized_keys"
        ? `${name} doesn't take ${iss.keys.map((k) => `'${k}'`).join(" or ")}. ${
            names.length > 0 ? `It takes ${names.join(", ")}.` : "It takes no arguments."
          }`
        : undefined,
  });
}

/** Today as the history tools' days are written, local "YYYY-MM-DD" (an error names it, since an
 *  agent may not know the date). */
export function localToday(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** A local day, "YYYY-MM-DD", to its first millisecond, or null when it isn't one (a day past the
 *  month's end too: Date would roll "2026-02-30" into March). */
export function localDayStart(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const at = new Date(y, mo, d);
  return at.getFullYear() === y && at.getMonth() === mo && at.getDate() === d ? at.getTime() : null;
}

/**
 * THE HISTORY TOOLS' DAYS, READ ONCE (0.16.0): from and to as local days, to the first millisecond
 * of from and the last of to, or the error that says what is accepted. Before, each tool parsed
 * its own and two of five checked: "last week" parsed to NaN, so list_history found nothing and
 * history_top ranked all time, both as ordinary answers.
 */
export const PERIOD_ARG = z
  .enum(["today", "yesterday", "last_7_days", "this_month", "this_year"])
  .optional()
  .describe(
    "A period in local days, instead of from and to: today, yesterday, the last 7 days (today one of them), this month or this year so far.",
  );

export function dayRange(a: {
  from?: string;
  to?: string;
  period?: "today" | "yesterday" | "last_7_days" | "this_month" | "this_year";
}): { from: number | null; to: number | null } | { error: string } {
  // A NAMED PERIOD (0.16.0): an agent may not know today's date, and "last week" was the
  // question it had tried to answer
  if (a.period != null) {
    if (a.from != null || a.to != null) return { error: "Give period, or from and to, not both." };
    const now = new Date();
    const day = (y: number, m: number, d: number): number => new Date(y, m, d).getTime();
    const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
    const endOfToday = day(y, m, d + 1) - 1;
    switch (a.period) {
      case "today":
        return { from: day(y, m, d), to: endOfToday };
      case "yesterday":
        return { from: day(y, m, d - 1), to: day(y, m, d) - 1 };
      case "last_7_days":
        return { from: day(y, m, d - 6), to: endOfToday };
      case "this_month":
        return { from: day(y, m, 1), to: endOfToday };
      case "this_year":
        return { from: day(y, 0, 1), to: endOfToday };
    }
  }
  const bad = (name: string, v: string): { error: string } => ({
    error: `"${v}" isn't a day: ${name} takes a local date, YYYY-MM-DD (today is ${localToday()}).`,
  });
  const from = a.from != null ? localDayStart(a.from) : null;
  if (a.from != null && from == null) return bad("from", a.from);
  const toStart = a.to != null ? localDayStart(a.to) : null;
  if (a.to != null && toStart == null) return bad("to", a.to);
  // the last millisecond of to's day, through the next midnight (a daylight-saving day is not 24h)
  const dayEnd = (start: number): number => {
    const d = new Date(start);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
  };
  const to = toStart != null ? dayEnd(toStart) : null;
  if (from != null && to != null && from > to)
    return { error: `from (${a.from}) is after to (${a.to}).` };
  return { from, to };
}

/**
 * A decade as an agent writes it, to its first year: "1990s", "1990", "90s", "'90s", "90", or a
 * year inside it ("1995"). Two digits under 30 are this century's ("20s" is the 2020s). Null when
 * it names none (0.16.0: only "1990" and "1990s" matched, and "90s" quietly matched nothing).
 */
export function decadeStart(v: string): number | null {
  const t = nameKey(v).replace(/^['’]/, "").replace(/s$/, "");
  if (/^\d{4}$/.test(t)) return Math.floor(Number(t) / 10) * 10;
  if (/^\d0$/.test(t)) return Number(t) >= 30 ? 1900 + Number(t) : 2000 + Number(t);
  return null;
}
export const DECADE_ARG = z
  .string()
  .optional()
  .describe("A decade: '1990s', '90s', '1990', or a year in it.");
export const decadeError = (v: string): string =>
  `"${v}" isn't a decade. Try '1990s', '90s' or a year such as '1994'.`;
/** Whether an item's year (a tag's "1994" or "1994-05-01") falls in the decade starting there. */
export const inDecade = (year: string | null | undefined, start: number): boolean => {
  const y = Number.parseInt(String(year ?? "").slice(0, 4), 10);
  return Number.isFinite(y) && y >= start && y < start + 10;
};

/** A genre as a filter compares it: folded and without its spaces, so "Hip Hop", "Hip-Hop" and
 *  "hiphop" are one genre (0.16.0: the filter was an exact match, and "Hip Hop" found nothing
 *  while "Hip-Hop" found six albums). */
export const genreKey = (g: string): string => searchFold(g).replace(/\s+/g, "");

/** Edits from one string to another: an insert, a delete, a change, or two neighbors swapped. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/**
 * THE NAMES CLOSEST TO WHAT WAS ASKED, for an answer that found nothing (0.16.0: "beatls" found
 * nothing and offered nothing). Compared folded, against the whole name and against each run of
 * its words as long as the query ("beatls" meets "Beatles" inside "The Beatles"), within a third
 * of the query's length; a name that contains the query, or is contained in it, comes first.
 * Closest first, then A to Z, at most `max`.
 */
export function nearestNames(query: string, names: Iterable<string>, max = 5): string[] {
  const q = searchFold(query).replace(/\s+/g, " ").trim();
  if (q === "") return [];
  const qWords = q.split(" ").length;
  const allowed = Math.max(1, Math.floor(q.length / 3));
  const scored = new Map<string, number>();
  for (const name of new Set(names)) {
    const f = searchFold(name).replace(/\s+/g, " ").trim();
    if (f === "") continue;
    let best = f.includes(q) || q.includes(f) ? 0 : editDistance(q, f);
    const words = f.split(" ");
    for (let i = 0; best > 0 && i + qWords <= words.length; i++)
      best = Math.min(best, editDistance(q, words.slice(i, i + qWords).join(" ")));
    if (best <= allowed) scored.set(name, best);
  }
  return [...scored]
    .sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0]))
    .slice(0, max)
    .map(([name]) => name);
}

/** What resume_album finds: the run left unfinished and where it stands, or why not. */
export type ResumeOffer =
  | {
      run: ReturnType<typeof resumeRun> & object;
      node: MediaNode;
      target: MediaNode;
      position: number;
      total: number;
    }
  | { reason: string };

/** A snapshot proven connected (the bridge's connected() throws otherwise). */
export type ConnectedSnapshot = Snapshot & {
  connection: Extract<ConnectionState, { phase: "connected" }>;
};

/** What the tool modules reach of the bridge: the device manager, the
 *  connected-or-throw snapshot, the index kick, the resume offer and the
 *  schedules write. Built by the bridge per server build. */
export interface ToolContext {
  dm: DeviceManager;
  connected(): ConnectedSnapshot;
  kickIndex(): string;
  resumeOffer(): Promise<ResumeOffer>;
  mutateSchedules(fn: (list: Schedule[]) => Schedule[]): void;
  /** Persist a settings patch and push it to every window (the scene tools, 2026-09-14). */
  saveSettings(patch: Partial<AppSettings>): AppSettings;
  /** A menu command to the main window (display mode on or off). */
  sendCommand(command: MenuCommand): void;
  /** Whether display mode is on, as the renderer last reported. */
  displayModeOn(): boolean;
  /** Whether the main window exists, for a command that should not open one (analyze_album). */
  windowOpen(): boolean;
}

/** The app's own state an agent can ask about beside the streamer's (2026-09-14): display
 *  mode on or off and the scene chosen for it, and the Now Playing tile's scene. */
export const appState = (
  ctx: ToolContext,
): {
  display_mode: { on: boolean; scene: AppSettings["displayScene"] };
  now_playing_tile: { scene: AppSettings["nowPlayingScene"] };
} => {
  const st = getSettings();
  return {
    display_mode: { on: ctx.displayModeOn(), scene: st.displayScene },
    now_playing_tile: { scene: st.nowPlayingScene },
  };
};

/** The history tools' optional streamer: a name from the device book or a live
 *  device, or a udn; "before-0.8.0" for the lines written before the field. */
export const STREAMER_ARG = z
  .string()
  .optional()
  .describe(
    "Only what one streamer played: its name or udn (list_devices). 'before-0.8.0' for lines written before the record named streamers.",
  );
export function streamerKeep(
  arg: unknown,
  devices: ReadonlyArray<{ udn: string; friendlyName: string }>,
): ((e: { streamer?: string | null }) => boolean) | null {
  if (typeof arg !== "string" || arg.trim() === "") return null;
  const needle = nameKey(arg);
  if (needle === "before-0.8.0") return (e) => e.streamer == null;
  const byName = [...getSettings().knownDevices, ...devices].find(
    (d) => nameKey(d.friendlyName) === needle,
  );
  const udn = byName?.udn ?? arg.trim();
  return (e) => e.streamer === udn;
}

const nodeIn = (pool: MediaIndexPools, id: string): MediaNode | null =>
  pool.albums.find((n) => n.id === id) ??
  pool.tracks.find((n) => n.id === id) ??
  pool.artists.find((n) => n.id === id) ??
  null;

/**
 * THE ID AN AGENT HOLDS MAY HAVE ROTTED (2026-09-14, the USB report: the
 * streamer's own USB server re-mints every object id across standby and a
 * replug). The app's playlist activation revalidates a Browse-built index
 * before trusting an id; the tools queued the id as it came, so a listing
 * from before the standby played nothing. Now: revalidate first (a
 * search-built or unindexed server answers at once), and when the index was
 * rebuilt, find the same thing again by content and answer its new id — or say
 * plainly that it was not found again.
 */
export async function freshObjectId(
  host: string,
  udn: string,
  id: string,
): Promise<{ id: string } | { error: string }> {
  const before = indexPools().find((p) => p.udn === udn);
  const node = before ? nodeIn(before, id) : null;
  if (!(await revalidate(host, udn, id))) return { id };
  const after = indexPools().find((p) => p.udn === udn);
  const again =
    node && after
      ? (node.isContainer ? [...after.albums, ...after.artists] : after.tracks).find(
          (n) =>
            nameKey(n.title) === nameKey(node.title) &&
            nameKey(n.artist) === nameKey(node.artist) &&
            (node.isContainer || nameKey(n.album) === nameKey(node.album)),
        )
      : null;
  if (!again)
    return {
      error: `The server's object ids changed (the drive re-mounted) and '${node?.title ?? id}' was not found again — run search_library or list_albums for fresh ids.`,
    };
  return { id: again.id };
}

/**
 * A TRACK REFERENCE (0.16.0): how an agent points at a track wherever a tool takes one, either
 * its ids from a listing or its content. One shape for every tool, so a list an agent holds goes
 * straight into a playlist or the queue.
 */
export const TRACK_REF = z.union([
  z.strictObject({
    server_udn: z.string().describe("From a listing (list_tracks, search_library)."),
    object_id: z.string().describe("The track's id from the same listing."),
  }),
  z.strictObject({
    title: z.string().min(1).describe("The track's title, as the library has it."),
    artist: z.string().optional(),
    album: z.string().optional().describe("Tells apart a title the library has more than once."),
  }),
]);
export type TrackRef = z.infer<typeof TRACK_REF>;
export const tracksArg = (max: number) =>
  z
    .array(TRACK_REF)
    .min(1)
    .max(max)
    .describe(
      `Up to ${max} tracks, in order: each {server_udn, object_id} from a listing, or {title, artist?, album?}.`,
    );

/** A library track as a playlist keeps it: its content, and its ids as the fast path. */
export const itemOfNode = (node: MediaNode, udn: string, serverName?: string): PlaylistItem => ({
  title: node.title,
  artist: node.artist,
  album: node.album,
  artUrl: node.artUrl,
  serverUdn: node.serverUdn ?? udn,
  serverName: node.serverName ?? serverName ?? null,
  objectId: node.id,
  durationSecs: node.durationSecs,
});

/** What a reference says, for the answer that names a track it couldn't find. */
export const refLabel = (ref: TrackRef): string =>
  "object_id" in ref ? ref.object_id : ref.artist ? `${ref.title} · ${ref.artist}` : ref.title;

/**
 * A reference to the library track it names, read from the index: ids must name a track (an
 * album's id is not one), content is matched as a heal matches it (resolveContent's rule, the
 * album telling twins apart). Null when the index has no such track.
 */
export function trackOfRef(ref: TrackRef): PlaylistItem | null {
  if ("object_id" in ref) {
    const pool = indexPools().find((p) => p.udn === ref.server_udn);
    const node = pool?.tracks.find((n) => n.id === ref.object_id);
    return pool && node ? itemOfNode(node, pool.udn, pool.serverName) : null;
  }
  const hit = bestInIndexes({
    title: ref.title,
    artist: ref.artist ?? null,
    album: ref.album ?? null,
  });
  return hit ? itemOfNode(hit.node, hit.serverUdn, hit.serverName) : null;
}

/** Several references at once: the tracks found, in order, and the labels of those not found. */
export function tracksOfRefs(refs: readonly TrackRef[]): {
  items: PlaylistItem[];
  missed: string[];
} {
  const items: PlaylistItem[] = [];
  const missed: string[] = [];
  for (const ref of refs) {
    const item = trackOfRef(ref);
    if (item) items.push(item);
    else missed.push(refLabel(ref));
  }
  return { items, missed };
}

/**
 * IDS ON EVERY ROW (0.16.0): a row that names a library track or album, a history line, a queue
 * entry, a ranked album, carries its server_udn and object_id when the index has its content, so
 * "play my most played album" is one call after the ranking, not a search on a label. Made once
 * per answer (the index read once).
 */
export type RowIds = { server_udn?: string; object_id?: string };
export function rowIds(): {
  track(ref: {
    title: string | null;
    artist?: string | null;
    album?: string | null;
    artUrl?: string | null;
  }): RowIds;
  album(title: string | null, artist: string | null): RowIds;
} {
  const find = indexFinder();
  let albums: Map<string, { udn: string; node: MediaNode }[]> | null = null;
  return {
    track: (ref) => {
      if (!ref.title) return {};
      const hit = find({
        title: ref.title,
        artist: ref.artist ?? null,
        album: ref.album ?? null,
        artUrl: ref.artUrl ?? null,
      });
      return hit ? { server_udn: hit.serverUdn, object_id: hit.node.id } : {};
    },
    album: (title, artist) => {
      if (!title) return {};
      if (!albums) {
        albums = new Map();
        for (const p of indexPools())
          for (const node of p.albums) {
            const key = nameKey(node.title);
            const list = albums.get(key) ?? [];
            list.push({ udn: p.udn, node });
            albums.set(key, list);
          }
      }
      const hits = albums.get(nameKey(title)) ?? [];
      const hit =
        hits.find(
          (h) =>
            artist == null ||
            nameKey(h.node.artist) === nameKey(artist) ||
            nameKey(h.node.albumArtist) === nameKey(artist),
        ) ?? (artist == null ? hits[0] : undefined);
      return hit ? { server_udn: hit.udn, object_id: hit.node.id } : {};
    },
  };
}

/** A few named and the rest counted: an answer about many tracks stays short. */
export const someTitles = (titles: readonly string[], shown = 3): string => {
  const more = titles.length - shown;
  return `${titles.slice(0, shown).join(", ")}${more > 0 ? `, +${more} more` : ""}`;
};

export const kindOf = (n: MediaNode): "album" | "artist" | "track" | "folder" =>
  n.upnpClass.includes("musicAlbum")
    ? "album"
    : n.upnpClass.includes("Artist") || n.upnpClass.includes("person")
      ? "artist"
      : n.upnpClass.includes("audioItem")
        ? "track"
        : "folder";

export const QUEUE_MODES: Record<string, MediaQueueAction> = {
  play_now: "PLAY_NOW",
  play_next: "PLAY_NEXT",
  append: "APPEND",
  replace: "REPLACE",
};

/** The agent's side of the large-queue guard: the app asks the user in a
 *  dialog; an agent is told to ask, and how to say yes. */
export const largeQueueAsk = (tracks: number, tool: string): string =>
  `That item holds ${tracks.toLocaleString()} tracks. Ask the user before queueing that many, then call ${tool} again with confirm_large: true.`;

/** Tone/EQ gate: caps when the streamer has them, a clean error otherwise. */
export const toneCaps = (
  ctx: ToolContext,
): { s: Snapshot; caps: NonNullable<ReturnType<typeof audioCaps>> } => {
  const s = ctx.connected();
  const caps = audioCaps(s.audioSpec);
  if (!caps) throw new Error("This streamer has no tone/EQ controls.");
  return { s, caps };
};

/** The preset-save contract: an occupied slot needs overwrite: true. */
export const guardSlot = (s: Snapshot, slot: number, overwrite: boolean): void => {
  const existing = (s.presets?.presets ?? []).find((p) => p.id === slot);
  if (existing && !overwrite) {
    throw new Error(
      `Slot ${slot} already holds "${existing.name ?? "a preset"}". Pass overwrite: true to replace it.`,
    );
  }
};

/** Whether the playing track's copy is hearted (0.13.0: a heart is per copy; the playing copy
 *  told apart by its picture, length and format against the library's other copies). */
function playingHearted(
  md: NonNullable<ZonePlayState["metadata"]>,
  favorites: Favorite[],
): boolean {
  const item = {
    kind: "track" as const,
    title: md.title ?? "",
    artist: md.artist ?? null,
    album: md.album ?? null,
    artUrl: md.art_url ?? null,
    serverUdn: null,
    durationSecs: md.duration ?? null,
    rate: md.sample_rate ?? null,
    bits: md.bit_depth ?? null,
  };
  return heartOf(item, favorites, heartPeersFrom(indexPools())(item)) != null;
}

export const status = (ctx: ToolContext): unknown => {
  const s = ctx.dm.snapshot();
  // the time and day as the user lives them (0.16.0): an agent may not know either, and the
  // history tools take local days
  const clock = { local_time: localTime(Date.now()), today: localToday() };
  if (s.connection.phase !== "connected") {
    return {
      ...clock,
      connection: s.connection.phase,
      hint: "Not connected. Use list_devices and connect_device.",
      ...appState(ctx),
    };
  }
  const md = s.playState?.metadata;
  const activeSourceId = s.zoneState?.source ?? s.nowPlaying?.source?.id ?? null;
  const sourceName =
    s.sources?.sources?.find((x) => x.id === activeSourceId)?.name ??
    s.nowPlaying?.source?.name ??
    null;
  return {
    ...clock,
    connection: "connected",
    device: {
      name: s.systemInfo?.name ?? null,
      model: s.systemInfo?.model ?? null,
      host: s.connection.host,
    },
    power: s.systemPower?.power ?? null,
    source: activeSourceId ? { id: activeSourceId, name: sourceName } : null,
    ...appState(ctx),
    playback: {
      state: s.playState?.state ?? null,
      title: md?.title ?? null,
      artist: md?.artist ?? null,
      album: md?.album ?? null,
      station: md?.station ?? null,
      position_seconds: s.position?.position ?? s.playState?.position ?? null,
      duration_seconds: md?.duration ?? null,
      queue_index: s.playState?.queue_index ?? null,
      // the queue list's own count, as list_queue says it: the play state's lags an append
      queue_length: s.queue?.total ?? s.playState?.queue_length ?? null,
      shuffle: s.playState?.mode_shuffle ?? null,
      repeat: s.playState?.mode_repeat ?? null,
      // The playing copy's heart, as the Now Playing heart reads it (station
      // URLs aren't knowable from playback metadata, so stations report null).
      favorited: md?.title != null && !md.station ? playingHearted(md, s.favorites) : null,
      format: md
        ? {
            codec: md.codec,
            sample_rate: md.sample_rate,
            bit_depth: md.bit_depth,
            lossless: md.lossless,
            bitrate: md.bitrate,
          }
        : null,
    },
    volume: {
      percent: s.zoneState?.volume_percent ?? null,
      step: s.zoneState?.volume_step ?? null,
      muted: s.zoneState?.mute ?? null,
      limit_percent: getSettings().volumeLimitPercent,
    },
    // Tone/EQ — present only on streamers whose firmware has the controls.
    audio: (() => {
      const caps = audioCaps(s.audioSpec);
      if (!caps) return null;
      const za = s.zoneAudio;
      return {
        user_eq_enabled: za?.user_eq?.enabled ?? false,
        band_gains_db: za?.user_eq?.bands?.map((b) => b.gain) ?? null,
        tilt: za?.tilt_eq ? { enabled: za.tilt_eq.enabled, intensity: za.tilt_eq.intensity } : null,
        balance: za?.balance ?? null,
      };
    })(),
    display: s.systemDisplay ? { brightness: s.systemDisplay.brightness } : null,
    sleep_timer: s.sleep
      ? {
          action: s.sleep.action,
          fires_at: s.sleep.firesAt != null ? localTime(s.sleep.firesAt) : null,
          end_of_track: s.sleep.minutes == null,
        }
      : null,
  };
};

/** The state an agent's next question is about (0.16.0): what plays, how loud, where in the
 *  queue. */
export function nowState(s: Snapshot): Record<string, unknown> {
  const md = s.playState?.metadata;
  return {
    state: s.playState?.state ?? null,
    title: md?.title ?? null,
    artist: md?.artist ?? null,
    ...(md?.album ? { album: md.album } : {}),
    ...(md?.station ? { station: md.station } : {}),
    position_seconds: s.position?.position ?? s.playState?.position ?? null,
    volume_percent: s.zoneState?.volume_percent ?? null,
    muted: s.zoneState?.mute ?? null,
    queue_position: s.playState?.queue_index ?? null,
    queue_length: s.queue?.total ?? s.playState?.queue_length ?? null,
  };
}

/**
 * RESULTS AFTER ACTIONS (0.16.0): an action's sentence and the state it leaves, once the streamer
 * says the change happened (`settled`, up to a second and a half; past that, the state as it then
 * is), so an agent need not ask get_status next ("turn it down a little" and say the new level was
 * two calls). Before, every action answered with a sentence alone.
 */
export async function acted(
  ctx: ToolContext,
  act: () => Promise<unknown>,
  done: string | ((now: Snapshot) => string),
  settled: (before: Snapshot, now: Snapshot) => boolean,
): Promise<ToolResult> {
  const before = ctx.dm.snapshot();
  await act();
  return settle(ctx, before, done, settled);
}

/** acted's wait for an action already taken: the state before it, then as above. */
export async function settle(
  ctx: ToolContext,
  before: Snapshot,
  done: string | ((now: Snapshot) => string),
  settled: (before: Snapshot, now: Snapshot) => boolean,
): Promise<ToolResult> {
  const until = Date.now() + 1500;
  let now = ctx.dm.snapshot();
  while (!settled(before, now) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    now = ctx.dm.snapshot();
  }
  return ok({ done: typeof done === "string" ? done : done(now), now: nowState(now) });
}

/** The queue's length changed (an add that plays nothing yet). */
export const queueGrew = (before: Snapshot, now: Snapshot): boolean =>
  (now.queue?.total ?? 0) !== (before.queue?.total ?? 0);

/** The playing track changed: another title, another queue place, or another station. */
export const trackMoved = (before: Snapshot, now: Snapshot): boolean =>
  now.playState?.metadata?.title !== before.playState?.metadata?.title ||
  now.playState?.queue_index !== before.playState?.queue_index ||
  now.playState?.metadata?.station !== before.playState?.metadata?.station;

/** Agent-facing schedule shape: 'wake' instead of the internal 'on'. */
export function scheduleOut(s: Schedule): Record<string, unknown> {
  return {
    id: s.id,
    enabled: s.enabled,
    time: s.time,
    days: s.days,
    action: s.action === "on" ? "wake" : "standby",
    preset_id: s.presetId,
    volume_percent: s.volumePercent,
  };
}
