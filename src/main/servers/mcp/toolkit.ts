import { z, type ZodRawShape } from "zod";
import { type MenuCommand, type Snapshot, type StreamerCommand } from "@shared/ipc";
import {
  type AppSettings,
  type ConnectionState,
  type MediaIndexPools,
  type MediaNode,
  type MediaQueueAction,
  type PlaylistItem,
  type Schedule,
  type SleepTimer,
} from "@shared/model";
import {
  creditNames,
  type Favorite,
  heartOf,
  heartPeersFrom,
  resumeRun,
  trackArtists,
} from "@shared/model";
import { activeSourceId, audioCaps, type ZonePlayState } from "@shared/smoip";
import type { DeviceManager } from "../../device/deviceManager";
import { getSettings } from "../../data/persist";
import { pools as indexPools, revalidate } from "../../media/mediaIndex";
import { indexFinder } from "../../media/resolveContent";
import { localOnly } from "../../lookups/fetchGuard";
import { matchesQuery, nameKey, searchFold } from "@shared/keys";
import { MCP_CLUSTERS, mcpClusterEnabled } from "@shared/mcpCatalog";

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

/**
 * Edits from one string to another (an insert, a delete, a change, or two neighbors swapped), or
 * more than `max` once it is sure to be: a miss's nearest names are compared against a whole
 * library, and a full table for each name had taken a fifth of a second a miss on 12,000 titles.
 * Two rows past `max` in a row settle it (a swap reaches back two rows).
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let prevLow = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, before[j - 2] + 1);
      cur.push(v);
      if (v < low) low = v;
    }
    if (low > max && prevLow >= max) return max + 1;
    before = prev;
    prev = cur;
    prevLow = low;
  }
  return prev[b.length];
}

/**
 * THE NAMES CLOSEST TO WHAT WAS ASKED, for an answer that found nothing (0.16.0: "beatls" found
 * nothing and offered nothing). Compared folded, against the whole name and against each run of
 * its words as long as the query ("beatls" meets "Beatles" inside "The Beatles"), within a third
 * of the query's length; a name that contains the query, or is contained in it as whole words,
 * comes first. A query under three letters has none.
 * Closest first, then A to Z, at most `max`.
 */
export function nearestNames(query: string, names: Iterable<string>, max = 5): string[] {
  const q = searchFold(query).replace(/\s+/g, " ").trim();
  // under three letters, a third of the query is one edit and every short word is near
  if (q.length < 3) return [];
  const qWords = q.split(" ").length;
  const allowed = Math.max(1, Math.floor(q.length / 3));
  const scored = new Map<string, number>();
  for (const name of new Set(names)) {
    const f = searchFold(name).replace(/\s+/g, " ").trim();
    if (f === "") continue;
    // a name inside the query counts as words of it, three letters or more: a title "N" had come
    // first for every miss with an n in it
    const inQuery = f.length >= 3 && ` ${q} `.includes(` ${f} `);
    let best = f.includes(q) || inQuery ? 0 : editDistance(q, f, allowed);
    const words = f.split(" ");
    for (let i = 0; best > 0 && i + qWords <= words.length; i++)
      best = Math.min(best, editDistance(q, words.slice(i, i + qWords).join(" "), allowed));
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

/**
 * THE STREAMER A TOOL ACTS ON (0.16.0, more than one streamer): the one the TastyTunes window
 * shows, or another named by the tool's device argument, reached on a background connection
 * (device/remoteStreamer) so the window stays where the user put it. The tools read and act
 * through this, never through the device manager directly, so one argument moves them all.
 */
export interface Target {
  /** The streamer the window shows (false: an agent's background connection). */
  window: boolean;
  host: string;
  name: string;
  /** Its state, as a snapshot (the app's own lists beside it, the window's). */
  snapshot(): ConnectedSnapshot;
  command(cmd: StreamerCommand): Promise<void>;
  queueAdd(
    serverUdn: string,
    objectId: string,
    action: MediaQueueAction,
    playFromId?: string,
    opts?: { confirmLarge?: boolean },
  ): Promise<void>;
  queueTracks(
    items: readonly PlaylistItem[],
    mode: "play_now" | "play_next" | "append" | "replace",
  ): Promise<{ added: number; missed: string[]; total: number; replaced: number | null }>;
  ensureAwake(): Promise<void>;
  setSleep(sleep: SleepTimer | null): void;
}

export const DEVICE_ARG = z
  .string()
  .optional()
  .describe(
    "Another streamer, by its name or host from list_devices: the tool acts on it and the TastyTunes window stays on its own. Default: the streamer the window shows.",
  );

/** What the tool modules reach of the bridge: the device manager, the
 *  connected-or-throw snapshot, the index kick, the resume offer and the
 *  schedules write. Built by the bridge per server build. */
export interface ToolContext {
  dm: DeviceManager;
  connected(): ConnectedSnapshot;
  /** The streamer a call acts on: the window's, or the one its device argument names. Throws
   *  (a clean tool error) when that streamer can't be reached. */
  target(device?: string): Promise<Target>;
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
export const TRACK_REF = z.union(
  [
    z.strictObject({
      server_udn: z.string().describe("From a listing (list_tracks, search_library)."),
      object_id: z.string().describe("The track's id from the same listing."),
    }),
    z.strictObject({
      title: z
        .string()
        .min(1)
        .describe(
          "The track's title, case, accents and punctuation ignored; with artist, a trailing part in parentheses or brackets may be left off.",
        ),
      artist: z.string().optional(),
      album: z.string().optional().describe("Tells apart a title the library has more than once."),
    }),
  ],
  { error: "A track is {server_udn, object_id} from a listing, or {title, artist?, album?}." },
);
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

/** A title as an agent's reference compares it: folded as search folds it (case, accents and
 *  punctuation set aside), its spaces collapsed, so "dont look back" is Don't Look Back. */
export const titleFold = (s: string | null | undefined): string =>
  searchFold(s).replace(/\s+/g, " ").trim();

/** A title with its trailing parenthesized or bracketed parts set aside ("Harbour Lights (feat.
 *  June Vale)" is "Harbour Lights"), or the title itself when that would leave nothing. */
export function bareTitle(title: string): string {
  let t = title.trim();
  for (;;) {
    const next = t.replace(/\s*(?:\([^()]*\)|\[[^[\]]*\])$/, "").trim();
    if (next === t || next === "") return t;
    t = next;
  }
}

/** What the title match reads of an item: its title and the names it is credited to. */
export interface Titled {
  title: string | null | undefined;
  credits: ReadonlyArray<string | null | undefined>;
}
export interface TitleRef {
  title: string;
  artist?: string | null;
}

/**
 * Whether a reference's artist is among an item's credits: each of its words among them, or, for a
 * credit written as one string ("A feat. B", the record's and the firmware's way), one of the names
 * it packs (creditNames, which a caller tries after the whole credit). An item crediting no one is
 * not ruled out (resolveContent's asymmetry). Before, "feat" had to be among the credits too, so a
 * reference copied from a history row missed every featured track.
 */
export function creditedBy(
  artist: string | null | undefined,
  credits: ReadonlyArray<string | null | undefined>,
): boolean {
  if (!artist?.trim() || credits.every((c) => !c)) return true;
  if (matchesQuery(artist, credits)) return true;
  const names = creditNames(artist);
  return names.length > 1 && names.some((n) => matchesQuery(n, credits));
}

/**
 * ONE TITLE MATCH FOR AN AGENT (0.16.0), asked by every tool that takes a title (a track
 * reference, history_stats, history_first_listen), so a song named from memory is found. The
 * title is folded as search folds it; failing that, with an artist named, a title matches once its
 * trailing parenthesized or bracketed part is set aside ("Harbour Lights" by Dusk Parade is
 * "Harbour Lights (feat. June Vale)"). A named artist is matched by creditedBy. Before, search
 * folded while a track reference and the history tools matched the title exactly, so a playlist
 * lost the songs an agent spelled without their apostrophe and history_stats answered zero plays
 * for them. Built once for many references.
 */
export function titleMatcher<T>(
  items: Iterable<T>,
  read: (item: T) => Titled,
): (ref: TitleRef) => T[] {
  type Entry = { item: T; credits: Titled["credits"] };
  const byTitle = new Map<string, Entry[]>();
  const byBare = new Map<string, Entry[]>();
  const add = (into: Map<string, Entry[]>, key: string, e: Entry): void => {
    const list = into.get(key);
    if (list) list.push(e);
    else into.set(key, [e]);
  };
  for (const item of items) {
    const { title, credits } = read(item);
    const folded = titleFold(title);
    if (!title || folded === "") continue;
    const e = { item, credits };
    add(byTitle, folded, e);
    const bare = titleFold(bareTitle(title));
    if (bare !== folded && bare !== "") add(byBare, bare, e);
  }
  return (ref) => {
    const want = titleFold(ref.title);
    if (want === "") return [];
    const artist = ref.artist?.trim() ? ref.artist : null;
    const credited = (e: Entry): boolean => creditedBy(artist, e.credits);
    const folded = (byTitle.get(want) ?? []).filter(credited);
    if (folded.length > 0 || artist == null) return folded.map((e) => e.item);
    return (byBare.get(want) ?? []).filter(credited).map((e) => e.item);
  };
}

/** The titles nearest a reference that matched nothing: among the named artist's own when any of
 *  theirs is near, else among them all. */
export function nearestTitles<T>(
  ref: TitleRef,
  items: Iterable<T>,
  read: (item: T) => Titled,
): string[] {
  const all: string[] = [];
  const theirs: string[] = [];
  for (const item of items) {
    const { title, credits } = read(item);
    if (!title) continue;
    all.push(title);
    if (ref.artist && credits.some(Boolean) && creditedBy(ref.artist, credits)) theirs.push(title);
  }
  const near = theirs.length > 0 ? nearestNames(ref.title, theirs) : [];
  return near.length > 0 ? near : nearestNames(ref.title, all);
}

/** A library track as an answer names it, ids included. */
export interface TrackRow {
  title: string;
  artist: string | null;
  album: string | null;
  server_udn: string;
  object_id: string;
}
/** A reference that named no one track: its place in the list sent, what it said, and why. */
export interface RefMiss {
  index: number;
  ref: string;
  note: string;
  nearest_titles?: string[];
  candidates?: TrackRow[];
}
/** A reference taken as a close match (folded, or a trailing part set aside), and what it became. */
export interface RefClose {
  index: number;
  ref: string;
  title: string;
  artist: string | null;
  album: string | null;
}
export interface RefsRead {
  items: PlaylistItem[];
  /** Each item's place in the list sent. */
  at: number[];
  close: RefClose[];
  missed: RefMiss[];
}

/** Misses past this many are named without nearest titles (each is a pass over the library). */
const NEAREST_FOR = 10;

/**
 * References to the library tracks they name, read from the index once for them all. Ids must
 * name a track (an album's id is said to be one). Content is matched first as a heal matches it
 * (resolveContent's rule, the album telling twins apart), then by the agent's title match: one
 * track, or one title on several albums (the album given telling them apart), is taken and named
 * among the close matches; titles that differ even once folded are different songs ("Paper Moons
 * [Demo]" and "Paper Moons [Live Demo]"), so those come back as candidates. Every miss is named
 * with its place in the list (0.16.0: four misses had answered with three names and "+1 more").
 * `early` holds the places already known missed, with why (an id the drive has re-minted).
 */
export function readTrackRefs(
  refs: readonly TrackRef[],
  early: ReadonlyMap<number, string> = new Map(),
): RefsRead {
  const groups = indexPools();
  const exact = indexFinder();
  type Hit = { node: MediaNode; pool: MediaIndexPools };
  let every: Hit[] | null = null;
  const tracks = (): Hit[] =>
    (every ??= groups.flatMap((pool) => pool.tracks.map((node) => ({ node, pool }))));
  const read = (h: Hit): Titled => ({
    title: h.node.title,
    credits: [...trackArtists(h.node), h.node.albumArtist],
  });
  let loose: ((ref: TitleRef) => Hit[]) | null = null;
  // the library's tracks by folded album, made once a call: a call naming 200 albums made a pass
  // over the whole library for each (0.16.0: 5 s on the main thread at 50,000 tracks)
  let byAlbum: Map<string, Hit[]> | null = null;
  const onAlbumNamed = (folded: string): Hit[] => {
    if (!byAlbum) {
      byAlbum = new Map();
      for (const h of tracks()) {
        const k = titleFold(h.node.album);
        const list = byAlbum.get(k);
        if (list) list.push(h);
        else byAlbum.set(k, [h]);
      }
    }
    return byAlbum.get(folded) ?? [];
  };
  const row = (h: Hit): TrackRow => ({
    title: h.node.title,
    artist: h.node.artist,
    album: h.node.album,
    server_udn: h.node.serverUdn ?? h.pool.udn,
    object_id: h.node.id,
  });
  const out: RefsRead = { items: [], at: [], close: [], missed: [] };
  const take = (index: number, item: PlaylistItem): void => {
    out.items.push(item);
    out.at.push(index);
  };
  refs.forEach((ref, index) => {
    const miss = (note: string, more: Partial<RefMiss> = {}): void => {
      out.missed.push({ index, ref: refLabel(ref), note, ...more });
    };
    const already = early.get(index);
    if (already != null) return miss(already);
    if ("object_id" in ref) {
      const pool = groups.find((p) => p.udn === ref.server_udn);
      const node = pool?.tracks.find((n) => n.id === ref.object_id);
      if (pool && node) return take(index, itemOfNode(node, pool.udn, pool.serverName));
      if (pool?.albums.some((n) => n.id === ref.object_id))
        return miss("An album's id, not a track's: get_media_info lists its tracks.");
      return miss(
        pool
          ? "No track with that id in that server's index."
          : "No indexed server with that server_udn.",
      );
    }
    const takeClose = (node: MediaNode, udn: string, serverName: string): void => {
      take(index, itemOfNode(node, udn, serverName));
      out.close.push({
        index,
        ref: refLabel(ref),
        title: node.title,
        artist: node.artist,
        album: node.album,
      });
    };
    // titles that still differ once folded are different songs, offered to choose between
    const choose = (found: readonly Hit[]): void => {
      const songs = new Map<string, Hit>();
      for (const h of found)
        if (!songs.has(titleFold(h.node.title))) songs.set(titleFold(h.node.title), h);
      if (songs.size > 1)
        return miss("Names more than one track: give one's server_udn and object_id.", {
          candidates: [...songs.values()].slice(0, 10).map(row),
        });
      takeClose(found[0].node, found[0].pool.udn, found[0].pool.serverName);
    };
    const album = ref.album != null ? titleFold(ref.album) : null;
    const onAlbum = (h: Hit): boolean => album != null && titleFold(h.node.album) === album;
    const hit = exact({ title: ref.title, artist: ref.artist ?? null, album: ref.album ?? null });
    if (hit && (album == null || titleFold(hit.node.album) === album))
      return take(index, itemOfNode(hit.node, hit.serverUdn, hit.serverName));
    // AN ALBUM NAMED IS THE AGENT'S OWN (0.16.0): the heal's rule lets the album only tell twins
    // apart, so a demo album's "Song [Demo]" had lost to the studio "Song", unsaid. The named
    // album's tracks come first, a trailing part set aside; failing them, the match on another
    // album is taken and said among the close matches.
    if (album != null) {
      const want = titleFold(ref.title);
      const there = onAlbumNamed(album).filter(
        (h) =>
          creditedBy(ref.artist, read(h).credits) &&
          (titleFold(h.node.title) === want || titleFold(bareTitle(h.node.title)) === want),
      );
      if (there.length > 0) return choose(there);
    }
    if (hit) return takeClose(hit.node, hit.serverUdn, hit.serverName);
    loose ??= titleMatcher(tracks(), read);
    const hits = loose(ref);
    if (hits.length === 0)
      return miss(
        "Not in the library index.",
        out.missed.length < NEAREST_FOR
          ? { nearest_titles: nearestTitles(ref, tracks(), read) }
          : {},
      );
    // the album given narrows them first, when any of them is on it
    const kept = hits.filter(onAlbum);
    choose(kept.length > 0 ? kept : hits);
  });
  return out;
}

/** What an answer adds about its references: the close matches and the misses, when any. */
export const refsNote = (r: RefsRead): Record<string, unknown> => ({
  ...(r.close.length > 0 ? { close_matches: r.close } : {}),
  ...(r.missed.length > 0 ? { not_found: r.missed } : {}),
});

/** The answer when no reference named a track: each miss, with its place and why. */
export const noTrackFound = (r: RefsRead): ToolResult =>
  err(
    `None of those names one track in the library index. Use list_tracks or search_library for their ids. ${JSON.stringify({ not_found: r.missed })}`,
  );

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

export const status = (ctx: ToolContext, t?: Target): unknown => {
  const s: Snapshot = t ? t.snapshot() : ctx.dm.snapshot();
  // the time and day as the user lives them (0.16.0): an agent may not know either, and the
  // history tools take local days
  const clock = { local_time: localTime(Date.now()), today: localToday(), ...toolsOff() };
  if (s.connection.phase !== "connected") {
    return {
      ...clock,
      connection: s.connection.phase,
      hint: "Not connected. Use list_devices and connect_device.",
      ...appState(ctx),
    };
  }
  const md = s.playState?.metadata;
  const sourceId = activeSourceId(s.zoneState, s.nowPlaying);
  const sourceName =
    s.sources?.sources?.find((x) => x.id === sourceId)?.name ?? s.nowPlaying?.source?.name ?? null;
  return {
    ...clock,
    connection: "connected",
    device: {
      name: s.systemInfo?.name ?? null,
      model: s.systemInfo?.model ?? null,
      host: s.connection.host,
      // the streamer the window shows, or another an agent reached (0.16.0)
      shown_in_window: t ? t.window : true,
    },
    power: s.systemPower?.power ?? null,
    source: sourceId ? { id: sourceId, name: sourceName } : null,
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

/**
 * THE TOOLS THAT ARE OFF, by name (0.16.0): with Playlist editing off, an agent saw no playlist
 * tools and told the user it could not make playlists. Now it can say where to turn them on.
 */
export function toolsOff(): {
  tools_off?: { groups: string[]; tools: string[]; where: string; then: string };
} {
  const mcp = getSettings().mcp;
  const groups = MCP_CLUSTERS.filter((c) => !mcpClusterEnabled(c, mcp)).map((c) => c.title);
  const tools = mcp.disabledTools ?? [];
  return groups.length === 0 && tools.length === 0
    ? {}
    : {
        tools_off: {
          groups,
          tools,
          where: "Settings › Integrations",
          // a client reads the tool list when it connects and keeps it (the server can't say it
          // changed: a fresh server every request), so one turned on shows only after a reconnect
          then: "After the user turns one on, reconnect to TastyTunes to see its tools.",
        },
      };
}

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
  t: Target,
  act: () => Promise<unknown>,
  done: string | ((now: Snapshot) => string),
  settled: (before: Snapshot, now: Snapshot) => boolean,
): Promise<ToolResult> {
  const before = t.snapshot();
  await act();
  return settle(t, before, done, settled);
}

/** acted's wait for an action already taken: the state before it, then as above. */
export async function settle(
  t: Target,
  before: Snapshot,
  done: string | ((now: Snapshot) => string),
  settled: (before: Snapshot, now: Snapshot) => boolean,
  extra: Record<string, unknown> = {},
): Promise<ToolResult> {
  const until = Date.now() + 1500;
  let now: Snapshot = t.snapshot();
  while (!settled(before, now) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    now = t.snapshot();
  }
  return ok({
    done: typeof done === "string" ? done : done(now),
    now: { ...nowState(now), ...(t.window ? {} : { streamer: t.name }) },
    ...extra,
  });
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
    // the streamer it acts on, when not the window's (0.16.0)
    streamer: s.streamer?.name ?? null,
  };
}

/**
 * THE STREAMER AN AGENT NAMES, ON THIS NETWORK ONLY (0.16.0). One seen on the network
 * or kept in the device book, by its name, udn or host; else the argument itself, when it is an
 * address only the local network has (a private or link-local address, a .local name). Never a
 * host on the internet: a device argument made the app resolve the name, open a socket to it and
 * keep asking, and connect_device made it "the streamer" (its pictures trusted, its media servers
 * called), an agent that had read a hostile station name or lyric being the path. One rule for a
 * tool's device argument and connect_device's host.
 */
export function streamerHostOf(
  arg: string,
  devices: ReadonlyArray<{ friendlyName: string; udn: string; host: string }>,
): { host: string } | { error: string } {
  const key = nameKey(arg);
  // by udn or host it is one streamer; by name it can be two (two rooms both called "Evo"), and
  // the first was taken unsaid (0.16.0): two streamers by one name are said, with their hosts
  const exact = devices.find((d) => nameKey(d.udn) === key || nameKey(d.host) === key);
  if (exact) return { host: exact.host };
  const byName = new Map<string, string>();
  for (const d of devices) if (nameKey(d.friendlyName) === key) byName.set(d.udn, d.host);
  if (byName.size > 1)
    return {
      error: `More than one streamer is called '${arg}' (at ${[...byName.values()].join(" and ")}). Pass the host instead.`,
    };
  const [named] = byName.values();
  if (named) return { host: named };
  const raw = arg.trim();
  const address = /^([\w.-]+)(?::\d+)?$/.exec(raw);
  if (address && /[.:]/.test(raw)) {
    if (localOnly(address[1])) return { host: raw };
    return {
      error: `'${raw}' isn't on this network. TastyTunes reaches only the streamers on it: list_devices names them.`,
    };
  }
  return { error: `No streamer called '${arg}'. Use list_devices for their names.` };
}
