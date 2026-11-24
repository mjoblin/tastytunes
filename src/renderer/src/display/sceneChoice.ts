import type { DisplayScene } from "@shared/model";
import { SCENE_TEXT } from "@shared/scenes";

/**
 * A SCENE FOR THIS SCREEN (0.17.0, Display on other screens): a screen can show a scene other
 * than the one TastyTunes shows (the lyrics on a tablet across the room, say). The choice is kept
 * in this browser only and never reaches the app: the page has no way back (the plan's rule 5,
 * a choice made on the page stays on the page). None kept means the app's own scene.
 */
const KEY = "tastytunes.displayScene";
const IDS = new Set<string>(SCENE_TEXT.map((s) => s.id));

/** This screen's scene, or null to show the app's. */
export function ownScene(): DisplayScene | null {
  try {
    const v = localStorage.getItem(KEY);
    return v != null && IDS.has(v) ? (v as DisplayScene) : null;
  } catch {
    return null;
  }
}

/** Keep a scene for this screen, or null to show the app's again. */
export function setOwnScene(id: DisplayScene | null): void {
  try {
    if (id == null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch {
    // a browser that keeps nothing (a private window) keeps the choice until the page reloads
    kept = id;
    return;
  }
  kept = undefined;
}
// the choice when the browser's storage refuses it
let kept: DisplayScene | null | undefined;

/** The scene this screen shows: its own when it has one, else the app's. */
export function sceneHere(appScene: DisplayScene): DisplayScene {
  return (kept !== undefined ? kept : ownScene()) ?? appScene;
}
