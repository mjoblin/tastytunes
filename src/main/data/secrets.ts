import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { isRecord } from "@shared/guards";
import { atomicWriteFileSync } from "./jsonStore";

// THE SECRETS STORE (0.13.0 round 10). The
// tokens the app holds, the ListenBrainz token a person pastes in and the MCP server's own, were
// kept in plain text in settings.json, the file people open and attach to bug reports, and every
// window received them with each settings push. Here, in their own file, each one encrypted with
// Electron's safeStorage (the macOS Keychain, DPAPI on Windows, the system keyring on Linux), read
// by the main process alone: no window, no agent tool and no export is handed a value; Settings
// learns only whether one is saved and its last four characters (secretHint). On a system with no
// keyring (a Linux without one) the value is kept as it was before, unencrypted, in a file only
// the user's account can read, and Settings says so. The suite's launches keep it that way too
// (TASTYTUNES_SECRETS_PLAIN): an unsigned test build touching the Keychain asks macOS for leave.

export type SecretName = "lbToken" | "mcpToken" | "fanartKey";

interface Stored {
  /** Encrypted with safeStorage (base64), or as it is where nothing can encrypt. */
  enc: boolean;
  value: string;
}

const filePath = (): string => join(app.getPath("userData"), "secrets.json");

// THE KEYCHAIN ONLY WHEN A SECRET IS USED (0.14.0, after rc.4's install asked macOS for the
// keychain): the file is read as it is, and an entry is decrypted only when its value is
// asked for, so a launch with no secrets, or with secrets nothing has asked for yet, never
// reaches safeStorage; saving one writes the others back as they were stored.
//
// SAFESTORAGE'S ASYNC CALLS (0.15.0): its sync calls are deprecated in Electron 45 and gone in 46,
// so reading, saving and the encryption question are async; whether a secret is saved stays a
// sync answer from the file, which needs no keychain.

/** The file's entries as stored, read once. */
let stored: Map<string, Stored> | null = null;
/** The values decrypted so far, in the main process's memory only. */
const values = new Map<string, string>();
/** A decryption under way, so two asks for one entry reach the keychain once. */
const decrypting = new Map<string, Promise<string | null>>();
/** Entries this system could not decrypt: still on disk until replaced, but not saved for use. */
const unreadable = new Set<string>();

/** Whether this system can encrypt a secret. */
export async function canEncrypt(): Promise<boolean> {
  if (process.env["TASTYTUNES_SECRETS_PLAIN"] === "1") return false;
  try {
    if (!(await safeStorage?.isAsyncEncryptionAvailable())) return false;
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
function valueOf(name: string): Promise<string | null> {
  const known = values.get(name);
  if (known != null) return Promise.resolve(known);
  const e = load().get(name);
  if (!e) return Promise.resolve(null);
  if (!e.enc) {
    values.set(name, e.value);
    return Promise.resolve(e.value);
  }
  let asked = decrypting.get(name);
  if (!asked) {
    asked = decrypt(name, e).finally(() => decrypting.delete(name));
    decrypting.set(name, asked);
  }
  return asked;
}

async function decrypt(name: string, e: Stored): Promise<string | null> {
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
      Buffer.from(e.value, "base64"),
    );
    if (!result) return null;
    // saved again or forgotten while this was decrypting: the store's newer answer stands
    if (load().get(name) !== e) return values.get(name) ?? null;
    values.set(name, result);
    // the keychain's key has moved on (rotated, or a stronger one is there): kept under the new one
    if (shouldReEncrypt) {
      load().set(name, { enc: true, value: await encrypt(result) });
      save();
    }
    return result;
  } catch {
    // a value this system cannot decrypt (another machine's keychain, a reset keychain) is
    // gone: asked for again, never guessed at
    unreadable.add(name);
    return null;
  }
}

const encrypt = async (v: string): Promise<string> =>
  (await safeStorage.encryptStringAsync(v)).toString("base64");

function save(): void {
  const entries: Record<string, Stored> = {};
  for (const [name, e] of load()) entries[name] = e;
  // readable to its owner only from the first byte, the temporary file included; a filesystem
  // without modes (Windows) ignores it, and DPAPI's encryption is the protection there
  atomicWriteFileSync(filePath(), JSON.stringify({ v: 1, entries }), 0o600);
}

/** A secret's value, for the main process's own use; null when none is saved. */
export function getSecret(name: SecretName): Promise<string | null> {
  return valueOf(name);
}

/** Whether a secret is saved and usable, without decrypting it: one this system could not
 *  decrypt reads as unsaved once that is known. */
export function hasSecret(name: SecretName): boolean {
  return load().has(name) && !unreadable.has(name);
}

/** Save a secret, or forget it (null or blank). */
export async function setSecret(name: SecretName, value: string | null): Promise<void> {
  const v = value?.trim() ?? "";
  if (v) {
    const enc = await canEncrypt();
    load().set(name, { enc, value: enc ? await encrypt(v) : v });
    values.set(name, v);
  } else {
    load().delete(name);
    values.delete(name);
  }
  unreadable.delete(name);
  save();
}

/** What Settings may know of a secret: whether one is saved, and its last four characters. */
export async function secretHint(
  name: SecretName,
): Promise<{ saved: boolean; ends: string | null }> {
  if (!hasSecret(name)) return { saved: false, ends: null };
  const v = await getSecret(name);
  return { saved: v != null, ends: v ? v.slice(-4) : null };
}

/** Whether saved secrets are encrypted here, asked without touching the keychain where it can
 *  be told otherwise: from what is stored, else macOS's Keychain and Windows' DPAPI are always
 *  there; only Linux has to ask whether a keyring is. */
export async function encryptsHere(): Promise<boolean> {
  if (process.env["TASTYTUNES_SECRETS_PLAIN"] === "1") return false;
  const saved = [...load().values()];
  if (saved.length > 0) return saved.every((e) => e.enc);
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return canEncrypt();
}
