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
 *  PageTransport), so a touch shows only the corner buttons and the keys do nothing. */
const HERE = { lockControls: isBool } as const;
type Here = { lockControls?: boolean };
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
  const { lockControls: _here, ...own } = kept();
  return own;
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
  write({ ...own, lockControls: kept().lockControls });
}

/** Whether this screen's controls are locked. */
export function controlsLocked(): boolean {
  return kept().lockControls === true;
}

/** Lock this screen's controls, or let them be used again. */
export function lockControls(on: boolean): void {
  write({ ...ownSettings(), lockControls: on });
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
