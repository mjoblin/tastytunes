import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isRecord } from "@shared/guards";
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
import { getSecret, setSecret } from "./secrets";

let cached: AppSettings | null = null;

/** The MCP server's bearer token (the secrets store's mcpToken): minted here and nowhere else. */
const mintToken = (): string => randomBytes(24).toString("base64url");

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
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    // our own file: an object is ours to read as settings (the cast says so;
    // missing or retired keys are backfilled below), anything else is ignored
    const file: Record<string, unknown> = isRecord(raw) ? raw : {};
    loaded = { ...DEFAULT_SETTINGS, ...(file as Partial<AppSettings>) };
    // The merge above is shallow — backfill nested objects from older files.
    loaded.mcp = { ...DEFAULT_SETTINGS.mcp, ...loaded.mcp };
    // The Tracks view had no Rows or Cards of its own before 0.13.0-rc.4 (it followed the
    // Library's one choice): an older file keeps what it showed
    if (!("lensTracksLayout" in file)) loaded.lensTracksLayout = loaded.libraryLayout;
    // Heal a display font that was retired (e.g. an older file naming a face no
    // longer in the curated set) back to the default so the picker stays in sync.
    if (!DISPLAY_FONT_IDS.includes(loaded.displayFont)) {
      loaded.displayFont = DEFAULT_SETTINGS.displayFont;
    }
    // Accent follows album art became one of the accent's choices (0.16.0): a file that had it on
    // keeps the album's color, one that had it off gets the default
    if (!("accent" in file)) {
      loaded.accent = file.accentFollowsArt === true ? "art" : DEFAULT_SETTINGS.accent;
    }
    // retired settings leave the file at the next write (0.16.0: the album-art switch, now an
    // accent choice; the ambient art's coverage and vignette, now always the whole window with it;
    // the Search screen's hidden categories, now one scope at a time, Everything first)
    for (const key of RETIRED) delete (loaded as unknown as Record<string, unknown>)[key];
    if (!ACCENT_IDS.includes(loaded.accent)) loaded.accent = DEFAULT_SETTINGS.accent;
    if (!DISPLAY_SCENE_IDS.includes(loaded.displayScene)) {
      loaded.displayScene = DEFAULT_SETTINGS.displayScene;
    }
    if (!DISPLAY_SCENE_IDS.includes(loaded.nowPlayingScene)) {
      loaded.nowPlayingScene = DEFAULT_SETTINGS.nowPlayingScene;
    }
  } catch {
    loaded = { ...DEFAULT_SETTINGS };
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
  if (lb) await setSecret("lbToken", lb);
  if (mcp && s.mcp.enabled) await setSecret("mcpToken", mcp);
  secretsMoved = true;
  if ("lbToken" in s || "token" in s.mcp) updateSettings({});
}

/** The MCP server's token, minted the first time the server runs (0.14.0; before, every install
 *  minted one at launch, and with it a keychain entry nobody asked for). */
export async function ensureMcpToken(): Promise<void> {
  if (!(await getSecret("mcpToken"))) await setSecret("mcpToken", mintToken());
}

/** A new MCP token: every agent on the old one stops working until it has this one. */
export function newMcpToken(): Promise<void> {
  return setSecret("mcpToken", mintToken());
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...getSettings(), ...patch };
  const next = secretsMoved ? withoutSecrets(merged) : merged;
  cached = next;
  try {
    // atomic (temp + rename) — a crash mid-write must not truncate settings.
    // Pretty-printed: this is the one file the user might open or diff.
    atomicWriteFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.error("failed to persist settings", err);
  }
  return next;
}
