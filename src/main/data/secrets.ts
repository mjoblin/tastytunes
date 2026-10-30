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

export type SecretName = "lbToken" | "mcpToken" | "fanartKey";

interface Stored {
  /** Encrypted with safeStorage (base64), or as it is where nothing can encrypt. */
  enc: boolean;
  value: string;
}

const filePath = (): string => join(app.getPath("userData"), "secrets.json");

// THE KEYCHAIN ONLY WHEN A SECRET IS USED (0.14.0, his call after rc.4's install asked his Mac
// for the keychain): the file is read as it is, and an entry is decrypted only when its value is
// asked for, so a launch with no secrets, or with secrets nothing has asked for yet, never
// reaches safeStorage; saving one writes the others back as they were stored.

/** The file's entries as stored, read once. */
let stored: Map<string, Stored> | null = null;
/** The values decrypted so far, in the main process's memory only. */
const values = new Map<string, string>();

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

function load(): Map<string, Stored> {
  if (stored) return stored;
  stored = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath(), "utf8"));
  } catch {
    return stored;
  }
  const entries = isRecord(parsed) && isRecord(parsed.entries) ? parsed.entries : {};
  for (const [name, e] of Object.entries(entries))
    if (isRecord(e) && typeof e.value === "string" && e.value)
      stored.set(name, { enc: e.enc === true, value: e.value });
  return stored;
}

/** An entry's value, decrypted the first time it is asked for. */
function valueOf(name: string): string | null {
  const known = values.get(name);
  if (known != null) return known;
  const e = load().get(name);
  if (!e) return null;
  try {
    const value = e.enc ? safeStorage.decryptString(Buffer.from(e.value, "base64")) : e.value;
    if (!value) return null;
    values.set(name, value);
    return value;
  } catch {
    // a value this system cannot decrypt (another machine's keychain, a reset keychain) is
    // gone: asked for again, never guessed at
    return null;
  }
}

function save(): void {
  const entries: Record<string, Stored> = {};
  for (const [name, e] of load()) entries[name] = e;
  atomicWriteFileSync(filePath(), JSON.stringify({ v: 1, entries }));
  try {
    chmodSync(filePath(), 0o600);
  } catch {
    // a filesystem without modes (Windows): DPAPI's encryption is the protection there
  }
}

/** A secret's value, for the main process's own use; null when none is saved. */
export function getSecret(name: SecretName): string | null {
  return valueOf(name);
}

/** Whether a secret is saved, without decrypting it. */
export function hasSecret(name: SecretName): boolean {
  return load().has(name);
}

/** Save a secret, or forget it (null or blank). */
export function setSecret(name: SecretName, value: string | null): void {
  const v = value?.trim() ?? "";
  if (v) {
    const enc = canEncrypt();
    load().set(name, {
      enc,
      value: enc ? safeStorage.encryptString(v).toString("base64") : v,
    });
    values.set(name, v);
  } else {
    load().delete(name);
    values.delete(name);
  }
  save();
}

/** What Settings may know of a secret: whether one is saved, and its last four characters. */
export function secretHint(name: SecretName): { saved: boolean; ends: string | null } {
  if (!hasSecret(name)) return { saved: false, ends: null };
  const v = getSecret(name);
  return { saved: v != null, ends: v ? v.slice(-4) : null };
}

/** Whether saved secrets are encrypted here, asked without touching the keychain where it can
 *  be told otherwise: from what is stored, else macOS's Keychain and Windows' DPAPI are always
 *  there; only Linux has to ask whether a keyring is. */
export function encryptsHere(): boolean {
  if (process.env["TASTYTUNES_SECRETS_PLAIN"] === "1") return false;
  const saved = [...load().values()];
  if (saved.length > 0) return saved.every((e) => e.enc);
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return canEncrypt();
}
