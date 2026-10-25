import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { isRecord } from "@shared/guards";
import { atomicWriteFileSync } from "./jsonStore";

// THE SECRETS STORE (0.13.0 round 10; his word, 2026-10-25: "secure tokens are important"). The
// tokens the app holds, the ListenBrainz token a person pastes in and the MCP server's own, were
// kept in plain text in settings.json, the file people open and attach to bug reports, and every
// window received them with each settings push. Here, in their own file, each one encrypted with
// Electron's safeStorage (the macOS Keychain, DPAPI on Windows, the system keyring on Linux), read
// by the main process alone: no window, no agent tool and no export is handed a value; Settings
// learns only whether one is saved and its last four characters (secretHint). On a system with no
// keyring (a Linux without one) the value is kept as it was before, unencrypted, in a file only
// the user's account can read, and Settings says so. The suite's launches keep it that way too
// (TASTYTUNES_SECRETS_PLAIN): an unsigned test build touching the Keychain asks his Mac for leave.

export type SecretName = "lbToken" | "mcpToken";

interface Stored {
  /** Encrypted with safeStorage (base64), or as it is where nothing can encrypt. */
  enc: boolean;
  value: string;
}

const filePath = (): string => join(app.getPath("userData"), "secrets.json");

/** The decrypted values, in the main process's memory only. */
let cache: Map<string, string> | null = null;

/** Whether this system can encrypt a secret. */
export function canEncrypt(): boolean {
  if (process.env["TASTYTUNES_SECRETS_PLAIN"] === "1") return false;
  try {
    if (!safeStorage?.isEncryptionAvailable()) return false;
    // Linux's last resort is a fixed key, which is no encryption at all
    if (process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text")
      return false;
    return true;
  } catch {
    return false;
  }
}

function load(): Map<string, string> {
  if (cache) return cache;
  cache = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath(), "utf8"));
  } catch {
    return cache;
  }
  const entries = isRecord(parsed) && isRecord(parsed.entries) ? parsed.entries : {};
  for (const [name, e] of Object.entries(entries)) {
    if (!isRecord(e) || typeof e.value !== "string") continue;
    try {
      const value =
        e.enc === true ? safeStorage.decryptString(Buffer.from(e.value, "base64")) : e.value;
      if (value) cache.set(name, value);
    } catch {
      // a value this system cannot decrypt (another machine's keychain, a reset keychain) is
      // gone: asked for again, never guessed at
    }
  }
  return cache;
}

function save(): void {
  const enc = canEncrypt();
  const entries: Record<string, Stored> = {};
  for (const [name, value] of load())
    entries[name] = enc
      ? { enc: true, value: safeStorage.encryptString(value).toString("base64") }
      : { enc: false, value };
  atomicWriteFileSync(filePath(), JSON.stringify({ v: 1, entries }));
  try {
    chmodSync(filePath(), 0o600);
  } catch {
    // a filesystem without modes (Windows): DPAPI's encryption is the protection there
  }
}

/** A secret's value, for the main process's own use; null when none is saved. */
export function getSecret(name: SecretName): string | null {
  return load().get(name) ?? null;
}

/** Save a secret, or forget it (null or blank). */
export function setSecret(name: SecretName, value: string | null): void {
  const v = value?.trim() ?? "";
  if (v) load().set(name, v);
  else load().delete(name);
  save();
}

/** What Settings may know of a secret: whether one is saved, and its last four characters. */
export function secretHint(name: SecretName): { saved: boolean; ends: string | null } {
  const v = getSecret(name);
  return { saved: v != null, ends: v ? v.slice(-4) : null };
}
