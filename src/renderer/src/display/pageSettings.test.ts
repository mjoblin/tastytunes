import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@shared/model";
import { DEFAULT_SETTINGS } from "@shared/model";
import {
  ALL_SCENES_KEYS,
  drawsScenes,
  forgetOwn,
  forThisPage,
  keepOwn,
  ownSettings,
} from "./pageSettings";

const app: AppSettings = { ...DEFAULT_SETTINGS, displayScene: "tide", displayCathodeFlicker: true };

const store = (): Map<string, string> => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  return m;
};

afterEach(() => {
  vi.unstubAllGlobals();
  drawsScenes(true);
});

describe("what a screen keeps for itself", () => {
  it("shows the app's until the screen sets its own, and the app's again once let go", () => {
    store();
    expect(forThisPage(app).displayScene).toBe("tide");
    keepOwn({ displayScene: "type", displayCathodeFlicker: false });
    expect(forThisPage(app)).toMatchObject({ displayScene: "type", displayCathodeFlicker: false });
    forgetOwn(ALL_SCENES_KEYS);
    expect(forThisPage(app)).toMatchObject({ displayScene: "type", displayCathodeFlicker: true });
    forgetOwn(["displayScene"]);
    expect(forThisPage(app).displayScene).toBe("tide");
  });

  it("keeps the lyric line for itself, and lets it go with the scenes' settings", () => {
    store();
    keepOwn({ displayLyrics: false });
    expect(forThisPage(app).displayLyrics).toBe(false);
    expect(app.displayLyrics).toBe(true);
    expect(ALL_SCENES_KEYS).toContain("displayLyrics");
    forgetOwn(ALL_SCENES_KEYS);
    expect(forThisPage(app).displayLyrics).toBe(true);
  });

  it("keeps only the display settings, each a value it may have", () => {
    const m = store();
    keepOwn({ theme: "light", lyrics: false, displaySyncMs: 120 });
    expect(ownSettings()).toEqual({ displaySyncMs: 120 });
    m.set(
      "tastytunes.display",
      JSON.stringify({
        displayScene: "nonsense",
        displayFinish: "chrome",
        displaySyncMs: 5e9,
        displayLyrics: "off",
      }),
    );
    expect(ownSettings()).toEqual({});
  });

  it("draws the Sleeve where the browser can't draw a scene", () => {
    store();
    keepOwn({ displayScene: "type" });
    drawsScenes(false);
    expect(forThisPage(app).displayScene).toBe("sleeve");
  });

  it("keeps its choices for the page's life when the browser keeps nothing", () => {
    const deny = (): never => {
      throw new Error("denied");
    };
    vi.stubGlobal("localStorage", { getItem: deny, setItem: deny, removeItem: deny });
    keepOwn({ displayScene: "refrain" });
    expect(forThisPage(app).displayScene).toBe("refrain");
    forgetOwn(["displayScene"]);
    expect(forThisPage(app).displayScene).toBe("tide");
  });
});
