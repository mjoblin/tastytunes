import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isRecord } from "@shared/guards";
import { join } from "node:path";
import { app } from "electron";
import {
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
    // Heal a display font that was retired (e.g. an older file naming a face no
    // longer in the curated set) back to the default so the picker stays in sync.
    if (!DISPLAY_FONT_IDS.includes(loaded.displayFont)) {
      loaded.displayFont = DEFAULT_SETTINGS.displayFont;
    }
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
 * before the store writes its tokens there (the installed 0.12.0 mints an MCP token where it
 * finds none). Every install has its own MCP token from its first launch, minted here when there
 * is none.
 */
export function moveSecrets(): void {
  const s = getSettings() as Legacy;
  const lb = typeof s.lbToken === "string" ? s.lbToken.trim() : "";
  const mcp = typeof s.mcp.token === "string" ? s.mcp.token.trim() : "";
  if (lb) setSecret("lbToken", lb);
  if (mcp) setSecret("mcpToken", mcp);
  if (!getSecret("mcpToken")) setSecret("mcpToken", mintToken());
  secretsMoved = true;
  if ("lbToken" in s || "token" in s.mcp) updateSettings({});
}

/** A new MCP token: every agent on the old one stops working until it has this one. */
export function newMcpToken(): void {
  setSecret("mcpToken", mintToken());
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
