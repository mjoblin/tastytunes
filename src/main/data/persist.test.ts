/**
 * Settings read from an older file: Accent follows album art became one of the accent's choices,
 * so a file that had it on keeps the album's color, one that had it off (or never had it) gets the
 * default, a stored choice is kept, an unknown one heals to the default; and retired settings (that
 * switch, the ambient art's coverage and vignette) leave the file at the next write.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/** getSettings on a fresh module, reading the given file from the stub's data folder. */
async function load(file: Record<string, unknown>) {
  vi.resetModules();
  const { app } = await import("electron");
  const path = join(app.getPath("userData"), "settings.json");
  writeFileSync(path, JSON.stringify(file));
  const persist = await import("./persist");
  return { settings: persist.getSettings(), persist, path };
}

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

  it("heals a choice it does not know to the default", async () => {
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
