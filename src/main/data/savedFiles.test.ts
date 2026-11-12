import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KEEP,
  keepAsFound,
  keepVersionCopy,
  onSavedNotes,
  readSaved,
  type SavedNote,
} from "./savedFiles";
import { jsonFileStore } from "./jsonStore";
import { checkFavorites } from "./savedChecks";

let dir = "";
let notes: SavedNote[] = [];
const at = (n: number): Date => new Date(2026, 10, 11, 9, 30, n);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saved-"));
  notes = [];
  onSavedNotes((n) => notes.push(n));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readSaved", () => {
  it("reads a missing file as missing, saying nothing", () => {
    expect(readSaved(join(dir, "favorites.json"))).toEqual({ state: "missing" });
    expect(notes).toEqual([]);
  });

  it("moves a file that isn't JSON aside before anything writes, and says so", () => {
    const path = join(dir, "favorites.json");
    writeFileSync(path, '[{"kind": "album", "title": "Amb');
    expect(readSaved(path, at(5))).toEqual({ state: "moved-aside" });
    expect(existsSync(path)).toBe(false);
    const aside = join(dir, "favorites.unreadable-2026-11-11T09-30-05.json");
    expect(readFileSync(aside, "utf-8")).toBe('[{"kind": "album", "title": "Amb');
    expect(notes).toEqual([
      {
        level: "warn",
        text: "favorites.json couldn't be read, so it was kept as favorites.unreadable-2026-11-11T09-30-05.json and a new one started",
      },
    ]);
  });

  it("keeps only the newest few files moved aside", () => {
    const path = join(dir, "playlists.json");
    for (let i = 0; i < KEEP + 2; i++) {
      writeFileSync(path, "{nope");
      readSaved(path, at(i));
    }
    const kept = readdirSync(dir)
      .filter((f) => f.startsWith("playlists.unreadable-"))
      .sort();
    expect(kept).toHaveLength(KEEP);
    expect(kept[0]).toBe("playlists.unreadable-2026-11-11T09-30-02.json");
  });

  it("reads a file it can't open as unreadable, and says changes won't be saved to it", () => {
    const path = join(dir, "settings.json");
    mkdirSync(path); // a folder where the file should be: the read fails, and not as missing
    expect(readSaved(path)).toEqual({ state: "unreadable" });
    expect(notes[0]?.level).toBe("error");
    expect(notes[0]?.text).toMatch(
      /^settings\.json couldn't be read \(.+\), so changes this session won't be saved to it$/,
    );
  });
});

describe("keepAsFound", () => {
  it("copies the file as it was aside and names each thing set aside", () => {
    const path = join(dir, "favorites.json");
    writeFileSync(path, "[1]");
    keepAsFound(path, ["[0] was a number, left out"], at(7));
    expect(readFileSync(join(dir, "favorites.as-found-2026-11-11T09-30-07.json"), "utf-8")).toBe(
      "[1]",
    );
    expect(notes.map((n) => n.text)).toEqual([
      "favorites.json: [0] was a number, left out",
      "favorites.json: 1 set aside; the file as it was is kept as favorites.as-found-2026-11-11T09-30-07.json",
    ]);
  });

  it("does nothing when nothing was set aside", () => {
    const path = join(dir, "favorites.json");
    writeFileSync(path, "[]");
    keepAsFound(path, []);
    expect(readdirSync(dir)).toEqual(["favorites.json"]);
    expect(notes).toEqual([]);
  });
});

describe("a store over a file that went bad", () => {
  const favorites = (): ReturnType<typeof jsonFileStore<unknown[]>> =>
    jsonFileStore<unknown[]>({
      pathOf: () => join(dir, "favorites.json"),
      scope: "favorites",
      load: (parsed, setAside) => checkFavorites(parsed, setAside),
    });
  const album = {
    kind: "album",
    addedAt: 1,
    title: "Amber Nights",
    artist: null,
    album: null,
    artUrl: null,
    serverUdn: null,
    serverName: null,
    objectId: null,
    titlePath: null,
  };

  it("keeps the good rows, the file as it was aside, and saves the good rows", () => {
    writeFileSync(join(dir, "favorites.json"), JSON.stringify([album, { kind: "album" }]));
    const store = favorites();
    expect(store.get()).toEqual([album]);
    expect(readdirSync(dir).some((f) => f.startsWith("favorites.as-found-"))).toBe(true);
    store.set([album]);
    expect(JSON.parse(readFileSync(join(dir, "favorites.json"), "utf-8"))).toEqual([album]);
  });

  it("never writes over a file it couldn't read", () => {
    mkdirSync(join(dir, "favorites.json"));
    const store = favorites();
    expect(store.get()).toEqual([]);
    store.set([album]);
    expect(store.get()).toEqual([album]); // held for the session
    expect(readdirSync(join(dir, "favorites.json"))).toEqual([]); // and the folder untouched
  });
});

describe("keepVersionCopy", () => {
  const FILES = ["settings.json", "favorites.json", "playlists.json"];

  it("copies the files as the last version left them, once per version, keeping the last few", () => {
    writeFileSync(join(dir, "settings.json"), '{"theme":"light"}');
    writeFileSync(join(dir, "favorites.json"), "[]");
    keepVersionCopy(dir, "0.16.0", FILES, at(0));
    // from before the backups: the version is unknown
    expect(readdirSync(join(dir, "backups")).sort()).toEqual([
      "earlier 2026-11-11",
      "last-version",
    ]);
    expect(readdirSync(join(dir, "backups", "earlier 2026-11-11")).sort()).toEqual([
      "favorites.json",
      "settings.json",
    ]);
    expect(readFileSync(join(dir, "backups", "last-version"), "utf-8")).toBe("0.16.0");
    // the same version again: nothing new
    keepVersionCopy(dir, "0.16.0", FILES, at(1));
    expect(readdirSync(join(dir, "backups"))).toHaveLength(2);
    // newer versions, each keeping the one before; only the last KEEP stay
    for (const [i, v] of ["1.0.0", "1.0.1", "1.1.0", "1.2.0"].entries()) {
      keepVersionCopy(dir, v, FILES, new Date(2026, 11, 1 + i, 12));
    }
    const kept = readdirSync(join(dir, "backups")).filter((f) => f !== "last-version");
    expect(kept).toHaveLength(KEEP);
    expect(kept).toContain("1.1.0 2026-12-04");
    expect(notes.at(-1)?.text).toBe(
      "settings.json, favorites.json from 1.1.0 kept in backups/1.1.0 2026-12-04",
    );
  });

  it("on a first run with no files, only remembers the version", () => {
    keepVersionCopy(dir, "0.16.0", FILES);
    expect(readdirSync(join(dir, "backups"))).toEqual(["last-version"]);
    expect(notes).toEqual([]);
  });
});
