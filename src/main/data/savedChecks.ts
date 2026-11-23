import { isRecord, kindOf } from "@shared/guards";
import { DEFAULT_SETTINGS, type AppSettings, type Favorite, type Playlist } from "@shared/model";

// THE ROWS AND VALUES OF THE SAVED FILES, CHECKED (0.16.0; data/savedFiles says why). In
// the wire check's manner (device/frameCheck): loose, so a field this version doesn't know is kept
// and a missing optional field stays missing; a field of the wrong kind is set aside (null where the
// type allows it, gone where it may be absent), a row without what it can't do without is left out,
// and each is named, for the log. A file that matches passes exactly as it came. Never a throw.
// favorites.json and playlists.json stay bare lists: a version from before 0.16.0 reads anything
// else as empty and would save over it.
//
// 1.0 IS THE OLDEST READER A LATER VERSION'S FILE WILL MEET (an update then a rollback, a backup
// restored), so what it doesn't know it carries through rather than drops: a row that is a record
// but not one of the shapes this version reads (a later kind of favorite, a later playlist item)
// is kept out of the app and written back at its place; a list a later version wrapped in an
// object ({..., items: [...]}) is read through it and written back in the form found. Only a row
// that isn't a record at all is left out, the file copied aside first (data/savedFiles).

/** What a load kept out of the app but writes back as it found it. */
export interface Carried {
  rows: Array<{ at: number; row: unknown }>;
  envelope: Record<string, unknown> | null;
  /** What was kept, for the log (no copy aside: nothing is lost). */
  notes: string[];
}
export const carriedNone = (): Carried => ({ rows: [], envelope: null, notes: [] });

/** The list as written: the app's rows with the carried ones back at their places, in the form
 *  the file was found in. */
export function withCarried<T>(list: readonly T[], carried: Carried): unknown {
  const out: unknown[] = [...list];
  for (const { at, row } of carried.rows) out.splice(Math.min(at, out.length), 0, row);
  return carried.envelope ? { ...carried.envelope, items: out } : out;
}

type Kind = "string" | "number" | "boolean" | "list" | "object";

const isKind = (v: unknown, kind: Kind): boolean =>
  kind === "list" ? Array.isArray(v) : kind === "object" ? isRecord(v) : typeof v === kind;

/** A field: its kind, and what a wrong one costs: the row ("need"), null ("null") or the field. */
interface Field {
  kind: Kind;
  /** need: without it the row is left out; null: may be null, set aside as null; else may be absent */
  is: "need" | "null" | "maybe";
  /** a list's entries, each of this kind; others left out */
  of?: Kind;
}

const need = (kind: Kind): Field => ({ kind, is: "need" });
const orNull = (kind: Kind, of?: Kind): Field => ({ kind, is: "null", of });
const maybe = (kind: Kind, of?: Kind): Field => ({ kind, is: "maybe", of });

/** One row checked against its fields: the row to keep, or null when it's left out. */
function checkRow(
  row: unknown,
  at: string,
  fields: Record<string, Field>,
  notes: string[],
): Record<string, unknown> | null {
  if (!isRecord(row)) {
    notes.push(`${at} was ${kindOf(row)}, left out`);
    return null;
  }
  let out: Record<string, unknown> | null = null; // copied on the first change only
  const change = (): Record<string, unknown> => (out ??= { ...row });
  for (const [key, f] of Object.entries(fields)) {
    if (!(key in row) || row[key] === undefined) {
      if (f.is !== "need") continue;
      notes.push(`${at} had no ${key}, left out`);
      return null;
    }
    const v = row[key];
    if (v === null && f.is === "null") continue;
    if (!isKind(v, f.kind)) {
      if (f.is === "need") {
        notes.push(`${at}.${key} was ${kindOf(v)}, so the row was left out`);
        return null;
      }
      notes.push(`${at}.${key} was ${kindOf(v)}, set aside`);
      if (f.is === "null") change()[key] = null;
      else delete change()[key];
      continue;
    }
    const of = f.of;
    if (of && Array.isArray(v)) {
      const kept = v.filter((it) => isKind(it, of));
      if (kept.length !== v.length) {
        notes.push(`${at}.${key} held ${v.length - kept.length} of the wrong kind, left out`);
        change()[key] = kept;
      }
    }
  }
  return out ?? row;
}

/** A list file's rows, each checked; anything but a list is no rows (and named). */
function checkList<T>(
  parsed: unknown,
  rowOf: (row: unknown, at: string, notes: string[]) => Record<string, unknown> | null,
  notes: string[],
  carried?: Carried,
): T[] {
  if (parsed === undefined) return [];
  let rows = parsed;
  if (carried && isRecord(parsed) && Array.isArray(parsed.items)) {
    const { items, ...envelope } = parsed;
    carried.envelope = envelope;
    rows = items;
  }
  if (!Array.isArray(rows)) {
    notes.push(`it held ${kindOf(parsed)}, not a list`);
    return [];
  }
  return rows.flatMap((row, i) => {
    const own: string[] = [];
    const kept = rowOf(row, `[${i}]`, own);
    if (!kept && carried && isRecord(row)) {
      carried.rows.push({ at: i, row });
      carried.notes.push(`[${i}] isn't a row this version reads, kept as it was`);
      return [];
    }
    notes.push(...own);
    return kept ? [kept as T] : [];
  });
}

const MEDIA: Record<string, Field> = {
  addedAt: need("number"),
  title: need("string"),
  artist: orNull("string"),
  album: orNull("string"),
  artUrl: orNull("string"),
  serverUdn: orNull("string"),
  serverName: orNull("string"),
  objectId: orNull("string"),
  titlePath: orNull("list", "string"),
  durationSecs: orNull("number"),
  copy: maybe("string"),
  rate: orNull("number"),
  bits: orNull("number"),
};

const STATION: Record<string, Field> = {
  addedAt: need("number"),
  name: need("string"),
  url: need("string"),
  favicon: orNull("string"),
  radioBrowserUuid: orNull("string"),
};

/** favorites.json: a station or an album or track a row, each by its kind's fields. */
export function checkFavorites(parsed: unknown, notes: string[], carried?: Carried): Favorite[] {
  return checkList<Favorite>(
    parsed,
    (row, at, n) => {
      const kind = isRecord(row) ? row.kind : undefined;
      if (isRecord(row) && kind !== "station" && kind !== "album" && kind !== "track") {
        n.push(`${at}.kind was ${typeof kind === "string" ? `"${kind}"` : kindOf(kind)}, left out`);
        return null;
      }
      return checkRow(row, at, kind === "station" ? STATION : MEDIA, n);
    },
    notes,
    carried,
  );
}

const ITEM: Record<string, Field> = {
  title: need("string"),
  artist: orNull("string"),
  album: orNull("string"),
  artUrl: orNull("string"),
  serverUdn: orNull("string"),
  serverName: orNull("string"),
  objectId: orNull("string"),
  durationSecs: orNull("number"),
};

const PLAYLIST: Record<string, Field> = {
  id: need("string"),
  name: need("string"),
  createdAt: need("number"),
  updatedAt: need("number"),
  items: need("list"),
  lastPlayedAt: orNull("number"),
  lastMissing: maybe("list", "string"),
};

/** What a playlists load carried through: whole playlists, and items within a playlist by its id. */
export interface PlaylistsCarried {
  lists: Carried;
  items: Map<string, Carried>;
}
export const playlistsCarriedNone = (): PlaylistsCarried => ({
  lists: carriedNone(),
  items: new Map(),
});

/** playlists.json: each playlist by its fields, and each of its items by theirs. */
export function checkPlaylists(
  parsed: unknown,
  notes: string[],
  carried?: PlaylistsCarried,
): Playlist[] {
  return checkList<Playlist>(
    parsed,
    (row, at, n) => {
      const list = checkRow(row, at, PLAYLIST, n);
      if (!list) return null;
      const items = list.items as unknown[];
      const kept = items.flatMap((it, j) => {
        const own: string[] = [];
        const item = checkRow(it, `${at}.items[${j}]`, ITEM, own);
        if (!item && carried && isRecord(it)) {
          const c = carried.items.get(list.id as string) ?? carriedNone();
          c.rows.push({ at: j, row: it });
          carried.items.set(list.id as string, c);
          carried.lists.notes.push(
            `${at}.items[${j}] isn't an item this version reads, kept as it was`,
          );
          return [];
        }
        n.push(...own);
        return item ? [item] : [];
      });
      return kept.length === items.length ? list : { ...list, items: kept };
    },
    notes,
    carried?.lists,
  );
}

/** The playlists as written: each with its carried items back, and the carried playlists. */
export function withCarriedPlaylists(
  list: readonly Playlist[],
  carried: PlaylistsCarried,
): unknown {
  const lists = list.map((p) => {
    const c = carried.items.get(p.id);
    return c ? { ...p, items: withCarried(p.items, c) } : p;
  });
  return withCarried(lists, carried.lists);
}

/** The settings whose default is null, and the kind each holds when it isn't. */
const NULLABLE: Partial<Record<keyof AppSettings, Kind>> = {
  lastHost: "string",
  volumeLimitPercent: "number",
  resumeDismissedAt: "number",
  nowPlayingArtShare: "number",
  libraryHeaderArt: "number",
  miniBounds: "object",
  mainBounds: "object",
  updateSnooze: "object",
  updateNotified: "string",
  agentExportFolder: "string",
};

/** The kind a setting's type holds, by its values (a literal union collapses to its one kind). */
type KindOfValue<T> = T extends string
  ? "string"
  : T extends number
    ? "number"
    : T extends boolean
      ? "boolean"
      : T extends readonly unknown[]
        ? "list"
        : T extends object
          ? "object"
          : never;
type SettingKind<K extends keyof AppSettings> = KindOfValue<NonNullable<AppSettings[K]>>;
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
/** The settings whose type mixes kinds (1 | 2 | 3 | "album"), which a default's one kind can't hold. */
type MixedKey = {
  [K in keyof AppSettings]: true extends IsUnion<SettingKind<K>> ? K : never;
}[keyof AppSettings];

/**
 * Every kind each mixed setting may hold. The type requires an entry for every setting whose type
 * mixes kinds, so a new one can't be checked against its default's kind alone and reset at each
 * launch. A setting never widens its kind in place: one that must hold a new kind takes a new key,
 * or a version that knows only the old kind would set the file aside.
 */
const MIXED: { readonly [K in MixedKey]: readonly SettingKind<K>[] } = {
  displayShuffleEvery: ["number", "string"],
};

function kindOfDefault(v: unknown): Kind | null {
  if (Array.isArray(v)) return "list";
  if (isRecord(v)) return "object";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return null;
}

/**
 * settings.json's values, each held to the kind of its default (DEFAULT_SETTINGS is the one
 * schema: a new setting is checked with no second list to keep), or to MIXED's kinds for a setting
 * whose type mixes them. A value of the wrong kind is left
 * out, so the default stands; a key this version doesn't know is kept. The nested mcp object's own
 * values are held the same way.
 */
export function checkSettingsKinds(
  file: Record<string, unknown>,
  notes: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...file };
  const hold = (
    into: Record<string, unknown>,
    defaults: Record<string, unknown>,
    nullable: Partial<Record<string, Kind>>,
    mixed: Partial<Record<string, readonly Kind[]>>,
    at: string,
  ): void => {
    for (const [key, def] of Object.entries(defaults)) {
      if (!(key in into)) continue;
      const v = into[key];
      const kinds = mixed[key] ?? [kindOfDefault(def) ?? nullable[key]];
      if (kinds.some((k) => k == null)) continue;
      if (v === null && (def === null || key in nullable)) continue;
      if (kinds.some((k) => k != null && isKind(v, k))) continue;
      notes.push(`${at}${key} was ${kindOf(v)}, so its default stands`);
      delete into[key];
    }
  };
  hold(out, DEFAULT_SETTINGS as unknown as Record<string, unknown>, NULLABLE, MIXED, "");
  if (isRecord(out.mcp)) {
    const mcp = { ...out.mcp };
    hold(mcp, DEFAULT_SETTINGS.mcp as unknown as Record<string, unknown>, {}, {}, "mcp.");
    out.mcp = mcp;
  }
  return out;
}

/** Every setting whose default is null has its kind named in NULLABLE (a unit test holds it). */
export const NULLABLE_KEYS = Object.keys(NULLABLE);
