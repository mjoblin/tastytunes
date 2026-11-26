/**
 * Settings read from an older file: Accent follows album art became one of the accent's choices,
 * so a file that had it on keeps the album's color, one that had it off (or never had it) gets the
 * default, a stored choice is kept, an unknown one is shown as the default and kept in the file; and
 * retired settings (that switch, the ambient art's coverage and vignette) leave the file at the next
 * write.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/model";

/** getSettings on a fresh module, reading the given file from the stub's data folder. */
async function load(file: Record<string, unknown>) {
  vi.resetModules();
  const { app } = await import("electron");
  const path = join(app.getPath("userData"), "settings.json");
  writeFileSync(path, JSON.stringify(file));
  const persist = await import("./persist");
  return { settings: persist.getSettings(), persist, path };
}

describe("the Library's views keep their own Rows or Cards", () => {
  it("gives an older file's Artists view the albums' choice, as it showed before", async () => {
    expect((await load({ libraryLayout: "rows" })).settings.lensArtistsLayout).toBe("rows");
    expect((await load({ libraryLayout: "cards" })).settings.lensArtistsLayout).toBe("cards");
  });

  it("gives an older file's artist page the albums' choice too", async () => {
    expect((await load({ libraryLayout: "rows" })).settings.artistPageLayout).toBe("rows");
    const { settings } = await load({ libraryLayout: "rows", artistPageLayout: "cards" });
    expect(settings.artistPageLayout).toBe("cards");
  });

  it("keeps the Artists view's own choice apart from the albums'", async () => {
    const { settings } = await load({ libraryLayout: "cards", lensArtistsLayout: "rows" });
    expect(settings.libraryLayout).toBe("cards");
    expect(settings.lensArtistsLayout).toBe("rows");
  });
});

describe("the accent read from a stored file", () => {
  it("keeps the album's color for a file that had Accent follows album art on", async () => {
    const { settings } = await load({ accentFollowsArt: true });
    expect(settings.accent).toBe("art");
    expect("accentFollowsArt" in settings).toBe(false);
  });

  it("gives the default to a file that had it off, or never had it", async () => {
    expect((await load({ accentFollowsArt: false })).settings.accent).toBe("sand");
    expect((await load({ theme: "light" })).settings.accent).toBe("sand");
  });

  it("keeps a stored choice, whatever the old switch said", async () => {
    expect((await load({ accent: "sage" })).settings.accent).toBe("sage");
    expect((await load({ accent: "gold" })).settings.accent).toBe("gold");
    expect((await load({ accent: "teal", accentFollowsArt: true })).settings.accent).toBe("teal");
  });

  it("shows a choice it does not know as the default", async () => {
    expect((await load({ accent: "plum" })).settings.accent).toBe("sand");
  });

  it("drops the ambient art's retired coverage and vignette, read and written", async () => {
    const { settings, persist, path } = await load({ ambientCoverage: "main", vignette: false });
    expect("ambientCoverage" in settings).toBe(false);
    expect("vignette" in settings).toBe(false);
    persist.updateSettings({});
    const written = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect("ambientCoverage" in written).toBe(false);
    expect("vignette" in written).toBe(false);
  });

  it("drops the Search screen's retired hidden categories, its scope starting at Everything", async () => {
    const { settings } = await load({ searchHidden: ["radio", "presets"] });
    expect("searchHidden" in settings).toBe(false);
    expect(settings.searchScope).toBe("everything");
  });

  it("drops the retired switch from the file at the next write", async () => {
    const { persist, path } = await load({ accentFollowsArt: true, theme: "light" });
    persist.updateSettings({});
    const written = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(written.accent).toBe("art");
    expect(written.theme).toBe("light");
    expect("accentFollowsArt" in written).toBe(false);
  });
});

describe("an accent, scene or face this version doesn't read is kept in the file", () => {
  const later = {
    accent: "plum",
    displayScene: "aurora",
    nowPlayingScene: "aurora",
    displayFont: "space-grotesk",
  };
  const written = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;

  it("shows each as its default, and writes each back as it was through another change", async () => {
    const { settings, persist, path } = await load({ ...later, theme: "light" });
    expect(settings.accent).toBe(DEFAULT_SETTINGS.accent);
    expect(settings.displayScene).toBe(DEFAULT_SETTINGS.displayScene);
    expect(settings.nowPlayingScene).toBe(DEFAULT_SETTINGS.nowPlayingScene);
    expect(settings.displayFont).toBe(DEFAULT_SETTINGS.displayFont);
    const next = persist.updateSettings({ theme: "dark" });
    // the app goes on showing the defaults
    expect(next.accent).toBe(DEFAULT_SETTINGS.accent);
    expect(persist.getSettings().displayFont).toBe(DEFAULT_SETTINGS.displayFont);
    expect(written(path)).toMatchObject({ ...later, theme: "dark" });
    // and the file's order of keys is the one this version writes
    expect(Object.keys(written(path))).toEqual(Object.keys(next));
  });

  it("writes the new choice once that setting is changed, the others still kept", async () => {
    const { persist, path } = await load(later);
    persist.updateSettings({ accent: "gold", displayScene: DEFAULT_SETTINGS.displayScene });
    expect(written(path)).toMatchObject({
      accent: "gold",
      displayScene: DEFAULT_SETTINGS.displayScene,
      nowPlayingScene: "aurora",
      displayFont: "space-grotesk",
    });
    persist.updateSettings({ theme: "light" });
    expect(written(path)).toMatchObject({ accent: "gold", nowPlayingScene: "aurora" });
  });

  it("writes the ones it reads as before", async () => {
    const { persist, path } = await load({ accent: "teal", displayScene: "tide" });
    persist.updateSettings({});
    expect(written(path)).toMatchObject({ accent: "teal", displayScene: "tide" });
    expect(written(path).displayFont).toBe(DEFAULT_SETTINGS.displayFont);
  });
});
