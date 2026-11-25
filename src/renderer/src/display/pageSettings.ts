import type { AppSettings } from "@shared/model";
import { SCENE_TEXT } from "@shared/scenes";

/**
 * WHAT A SCREEN KEEPS FOR ITSELF (0.17.0, Display on other screens): a screen can show a scene
 * other than the one TastyTunes shows (the lyrics on a tablet across the room, say), and set the
 * scenes' display-wide settings its own way (the glass's flicker, the corners, the drops, the
 * sync with the sound, which a screen across the network may want to differ). Kept in this
 * browser only and never sent to the app: the page has no way back (the plan's rule 5, a choice
 * made on the page stays on the page). A setting the screen hasn't set is the app's.
 */
const KEY = "tastytunes.display";

const isBool = (v: unknown): boolean => typeof v === "boolean";
const SCENE_IDS = new Set<string>(SCENE_TEXT.map((s) => s.id));
/** The settings a screen may keep, each with what a kept value may be. */
const OWN = {
  displayScene: (v: unknown) => typeof v === "string" && SCENE_IDS.has(v),
  displayFinish: (v: unknown) => v === "plain" || v === "cathode",
  displayCathodeCurve: (v: unknown) => v === "gentle" || v === "deep",
  displayCathodeFill: isBool,
  displayCathodeFlicker: isBool,
  displayCornerTitle: isBool,
  displayCornerClock: isBool,
  displayProgress: isBool,
  displayDrops: (v: unknown) => v === "loose" || v === "normal" || v === "strict",
  displaySyncMs: (v: unknown) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1000,
} satisfies Partial<Record<keyof AppSettings, (v: unknown) => boolean>>;
export type OwnKey = keyof typeof OWN;

/** What a screen keeps that the app has no setting for: its controls locked (display/
 *  PageTransport), so a touch shows only the corner buttons and the keys do nothing; and how its
 *  list shows the queue, the presets and the playlists, rows or cards (the menu bar panel's
 *  choice). */
const isView = (v: unknown): boolean => v === "rows" || v === "cards";
const HERE = {
  lockControls: isBool,
  queueView: isView,
  presetsView: isView,
  playlistsView: isView,
} as const;
export type ListView = "rows" | "cards";
type Here = {
  lockControls?: boolean;
  queueView?: ListView;
  presetsView?: ListView;
  playlistsView?: ListView;
};
/** The list's tabs (display/PageTransport). */
export type ListTab = "queue" | "presets" | "playlists";
const VIEW_KEY = {
  queue: "queueView",
  presets: "presetsView",
  playlists: "playlistsView",
} as const satisfies Record<ListTab, keyof Here>;
/** Each tab's view until this screen chooses: the presets as cards (the window's Presets screen),
 *  the queue and the playlists as rows (the menu bar panel's). */
const VIEW_FIRST: Record<ListTab, ListView> = {
  queue: "rows",
  presets: "cards",
  playlists: "rows",
};
/** Every setting a screen may keep. */
export const OWN_KEYS = Object.keys(OWN) as OwnKey[];
type Own = Partial<Pick<AppSettings, OwnKey>>;
/** The scenes' display-wide settings (the window's All scenes): every kept key but the scene. */
export const ALL_SCENES_KEYS = OWN_KEYS.filter((k) => k !== "displayScene");

// what this screen keeps when the browser's storage refuses it (a private window), for the
// page's life
let memory: (Own & Here) | null = null;

/** Everything kept, each key checked against what it may be; anything else is dropped. */
function kept(): Own & Here {
  let raw: unknown = memory;
  if (memory == null)
    try {
      raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    } catch {
      raw = {};
    }
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === "object")
    for (const [k, ok] of [...Object.entries(OWN), ...Object.entries(HERE)]) {
      const v = (raw as Record<string, unknown>)[k];
      if (v !== undefined && ok(v)) out[k] = v;
    }
  return out;
}

/** What this screen keeps of the app's settings: only known settings, each a value it may have. */
export function ownSettings(): Own {
  const all: Record<string, unknown> = { ...kept() };
  for (const k of Object.keys(HERE)) delete all[k];
  return all;
}

/** What this screen keeps of its own. */
function here(): Here {
  const all = kept();
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(HERE)) if (k in all) out[k] = (all as Record<string, unknown>)[k];
  return out;
}

/** Keep these of this screen's own, beside the rest it keeps. */
function keepHere(patch: Here): void {
  write({ ...ownSettings(), ...here(), ...patch });
}

function write(own: Own & Here): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(own));
    memory = null;
  } catch {
    memory = own;
  }
}

/** The app's settings this screen keeps, beside what it keeps of its own. */
function store(own: Own): void {
  write({ ...own, ...here() });
}

/** Whether this screen's controls are locked. */
export function controlsLocked(): boolean {
  return kept().lockControls === true;
}

/** Lock this screen's controls, or let them be used again. */
export function lockControls(on: boolean): void {
  keepHere({ lockControls: on });
}

/** How this screen's list shows a tab (VIEW_FIRST until it chooses). */
export function listView(tab: ListTab): ListView {
  return here()[VIEW_KEY[tab]] ?? VIEW_FIRST[tab];
}

export function keepListView(tab: ListTab, view: ListView): void {
  const patch: Partial<Here> = {};
  patch[VIEW_KEY[tab]] = view;
  keepHere(patch);
}

/** Keep, for this screen, the settings of `patch` a screen may keep (the rest are dropped). */
export function keepOwn(patch: Partial<AppSettings>): void {
  const own: Record<string, unknown> = { ...ownSettings() };
  for (const [k, ok] of Object.entries(OWN)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v !== undefined && ok(v)) own[k] = v;
  }
  store(own);
}

/** Let these go: this screen shows the app's again. */
export function forgetOwn(keys: readonly OwnKey[]): void {
  const own = { ...ownSettings() };
  for (const k of keys) delete own[k];
  store(own);
}

let scenesHere = true;
/** Whether this browser draws the scenes (display/page asks it once); without, the Sleeve. */
export function drawsScenes(on: boolean): void {
  scenesHere = on;
}

/** The app's settings as this screen draws them: its own where it has them, and the Sleeve where
 *  it can't draw a scene. */
export function forThisPage(s: AppSettings): AppSettings {
  const out: AppSettings = { ...s, ...ownSettings() };
  if (!scenesHere) out.displayScene = "sleeve";
  return out;
}
