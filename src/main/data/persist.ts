import { randomBytes } from "node:crypto";
import { isRecord, kindOf } from "@shared/guards";
import { MCP_RENAMED_TOOLS } from "@shared/mcpCatalog";
import { join } from "node:path";
import { app } from "electron";
import {
  ACCENT_IDS,
  DEFAULT_SETTINGS,
  DISPLAY_FONT_IDS,
  DISPLAY_SCENE_IDS,
  type AppSettings,
} from "@shared/model";
import { atomicWriteFileSync } from "./jsonStore";
import { checkSettingsKinds } from "./savedChecks";
import { keepAsFound, noteSaved, readSaved, saveFailed } from "./savedFiles";
import { readSecret, renewSecret, setSecret } from "./secrets";

let cached: AppSettings | null = null;
/** settings.json couldn't be read this session: nothing writes over it (data/savedFiles). */
let unreadable = false;

/** The MCP server's bearer token (the secrets store's mcpToken): minted here and nowhere else. */
const mintToken = (): string => randomBytes(24).toString("base64url");

/** The settings that hold one of a set of ids, and the ids this version reads. An id it doesn't
 *  read (a later version's accent, scene or face, or a face since retired) is shown as the default
 *  and written back as the file had it, until that setting is changed: an update then a rollback
 *  keeps the later version's choice for when it runs again. */
const IDS = {
  accent: ACCENT_IDS,
  displayScene: DISPLAY_SCENE_IDS,
  nowPlayingScene: DISPLAY_SCENE_IDS,
  displayFont: DISPLAY_FONT_IDS,
} as const satisfies Partial<Record<keyof AppSettings, readonly string[]>>;
/** The ids this session shows as the default, by setting, as the file had them. */
let carriedIds: Partial<Record<keyof AppSettings, unknown>> = {};

/** Settings that once were and are no longer: dropped from a file read, so a write leaves them out. */
const RETIRED = ["accentFollowsArt", "ambientCoverage", "vignette", "searchHidden"] as const;

/** The tokens settings.json held before the secrets store (0.13.0): read only to move them. */
type Legacy = AppSettings & { lbToken?: unknown; mcp: AppSettings["mcp"] & { token?: unknown } };
/** The tokens have moved: from here on a write never carries them back into settings.json. */
let secretsMoved = false;

/** A settings object without the tokens that once lived in it. */
function withoutSecrets(s: AppSettings): AppSettings {
  const { lbToken: _lb, ...rest } = s as Legacy;
  const { token: _token, ...mcp } = (s as Legacy).mcp;
  return { ...rest, mcp };
}

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

export function getSettings(): AppSettings {
  if (cached) return cached;
  let loaded: AppSettings;
  // THE FILE CHECKED ON LOAD (0.16.0, data/savedFiles and data/savedChecks): a file that isn't JSON
  // is moved aside, one that can't be read is never written over this session, and a value of the
  // wrong kind is set aside so its default stands, the file as it was copied aside first
  const path = settingsPath();
  const read = readSaved(path);
  unreadable = read.state === "unreadable";
  const setAside: string[] = [];
  const raw = read.state === "read" ? read.parsed : undefined;
  if (raw !== undefined && !isRecord(raw)) setAside.push(`it held ${kindOf(raw)}, not settings`);
  // our own file: an object is ours to read as settings (missing or retired keys are backfilled
  // below), anything else is ignored
  const file = checkSettingsKinds(isRecord(raw) ? raw : {}, setAside);
  keepAsFound(path, setAside);
  try {
    loaded = { ...DEFAULT_SETTINGS, ...(file as Partial<AppSettings>) };
    // The merge above is shallow — backfill nested objects from older files.
    loaded.mcp = { ...DEFAULT_SETTINGS.mcp, ...loaded.mcp };
    // an agent tool renamed keeps the user's choice to switch it off
    loaded.mcp.disabledTools = loaded.mcp.disabledTools.map((n) => MCP_RENAMED_TOOLS[n] ?? n);
    // The Tracks view had no Rows or Cards of its own before 0.13.0-rc.4 (it followed the
    // Library's one choice): an older file keeps what it showed
    if (!("lensTracksLayout" in file)) loaded.lensTracksLayout = loaded.libraryLayout;
    // nor the Artists view and an artist's page before 0.16.0: an older file keeps what it showed
    if (!("lensArtistsLayout" in file)) loaded.lensArtistsLayout = loaded.libraryLayout;
    if (!("artistPageLayout" in file)) loaded.artistPageLayout = loaded.libraryLayout;
    // Accent follows album art became one of the accent's choices (0.16.0): a file that had it on
    // keeps the album's color, one that had it off gets the default
    if (!("accent" in file)) {
      loaded.accent = file.accentFollowsArt === true ? "art" : DEFAULT_SETTINGS.accent;
    }
    // retired settings leave the file at the next write (0.16.0: the album-art switch, now an
    // accent choice; the ambient art's coverage and vignette, now always the whole window with it;
    // the Search screen's hidden categories, now one scope at a time, Everything first)
    for (const key of RETIRED) delete (loaded as unknown as Record<string, unknown>)[key];
    // an id this version doesn't read is shown as the default, so the pickers stay in step, and
    // kept to be written back as found (IDS)
    carriedIds = {};
    for (const [key, ids] of Object.entries(IDS) as [keyof typeof IDS, readonly string[]][]) {
      const id = loaded[key];
      if (ids.includes(id)) continue;
      carriedIds[key] = id;
      (loaded as unknown as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
      noteSaved(
        "info",
        `settings.json: ${key} ${JSON.stringify(id)} isn't one this version reads, shown as the default and kept as it was`,
      );
    }
  } catch {
    loaded = { ...DEFAULT_SETTINGS };
    carriedIds = {};
  }
  cached = loaded;
  return cached;
}

/**
 * MOVE THE TOKENS INTO THE SECRETS STORE (0.13.0 round 10; main/data/secrets): once, in whenReady
 * before any window opens (safeStorage needs the app ready; a window then never receives one).
 * A token found in settings.json moves and leaves the file: the newer one wins, since a build from
 * before the store writes its tokens there. The MCP token moves only while the agent server is on:
 * 0.12.0 minted one for every install, and one nobody turned the server on for is dropped rather
 * than carried into the keychain (0.14.0: the keychain only when a secret is used); turning the
 * server on mints a new one (ensureMcpToken).
 */
export async function moveSecrets(): Promise<void> {
  const s = getSettings() as Legacy;
  const lb = typeof s.lbToken === "string" ? s.lbToken.trim() : "";
  const mcp = typeof s.mcp.token === "string" ? s.mcp.token.trim() : "";
  try {
    if (lb) await setSecret("lbToken", lb);
    if (mcp && s.mcp.enabled) await setSecret("mcpToken", mcp);
  } catch {
    // the secrets file couldn't be read, or a token couldn't be encrypted: the tokens stay in
    // settings.json for a later launch to move, rather than be lost, and the launch goes on
    return;
  }
  secretsMoved = true;
  if ("lbToken" in s || "token" in s.mcp) updateSettings({});
}

/** The MCP server's token, minted the first time the server runs (0.14.0; before, every install
 *  minted one at launch, and with it a keychain entry nobody asked for). Only when none is saved:
 *  one saved that couldn't be read is kept as it is, and Settings says so (its New token replaces
 *  it), since a token made in its place would quietly stop every agent that has the old one. */
export async function ensureMcpToken(): Promise<void> {
  if ((await readSecret("mcpToken")).state === "absent") await setSecret("mcpToken", mintToken());
}

/** A new MCP token (New token, confirmed): every agent on the old one stops working until it has
 *  this one. True when the saved keys couldn't be read and were set aside to make it
 *  (data/secrets renewSecret). */
export function newMcpToken(): Promise<boolean> {
  return renewSecret("mcpToken", mintToken());
}

/** The token in Display on other screens' address, minted the first time it is turned on; null
 *  when one is saved and couldn't be read. That one is kept as it is and never minted over (a new
 *  address would end every screen and approval without a word): the server waits for New address
 *  (main/app/display). */
export function displayToken(): Promise<string | null> {
  // the first mint held, so a request that arrives while it is written reads the same token
  minting ??= (async () => {
    const have = await readSecret("displayToken");
    if (have.state === "saved") return have.value;
    if (have.state === "unreadable") return null;
    const token = mintToken();
    await setSecret("displayToken", token);
    return token;
  })().finally(() => {
    minting = null;
  });
  return minting;
}
let minting: Promise<string | null> | null = null;

/** A new display address (New address, confirmed): every screen on the old one shows the "open
 *  the address" page until it is opened again. True when the saved keys couldn't be read and were
 *  set aside to make it (data/secrets renewSecret). */
export function newDisplayToken(): Promise<boolean> {
  return renewSecret("displayToken", mintToken());
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...getSettings(), ...patch };
  // a setting changed holds the new choice from here on: an id carried for it is let go
  for (const key of Object.keys(patch)) delete carriedIds[key as keyof AppSettings];
  const next = secretsMoved ? withoutSecrets(merged) : merged;
  cached = next;
  if (unreadable) return next;
  try {
    // atomic (temp + rename) — a crash mid-write must not truncate settings.
    // Pretty-printed: this is the one file the user might open or diff.
    // The ids carried go back in their own places (every one is a key the settings already have).
    atomicWriteFileSync(settingsPath(), JSON.stringify({ ...next, ...carriedIds }, null, 2));
  } catch (err) {
    console.error("failed to persist settings", err);
    // said once a session (data/savedFiles saveFailed)
    if (!settingsFailSaid) {
      settingsFailSaid = true;
      saveFailed("your settings", err);
    }
  }
  return next;
}
let settingsFailSaid = false;
