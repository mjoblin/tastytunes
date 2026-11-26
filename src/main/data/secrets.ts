import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { errorMessage, isRecord, kindOf } from "@shared/guards";
import { atomicWriteFileSync } from "./jsonStore";
import { noteSaved } from "./savedFiles";
import { devOverride } from "../app/devOverride";

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

export type SecretName = "lbToken" | "mcpToken" | "fanartKey" | "displayToken";

/** A secret as the store holds it: its value; absent, none saved; or unreadable, one saved that
 *  this system can't decrypt (another computer's keychain, a reset or locked one, an ask that was
 *  turned down), kept on disk as it is, or any secret while the file can't be read. A token is
 *  minted only when absent, never over an unreadable one (data/persist). */
export type SecretRead = { state: "saved"; value: string } | { state: "absent" | "unreadable" };

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
/** THE FILE THAT CAN'T BE READ IS NOT AN EMPTY ONE (0.17.0): only a missing file has nothing
 *  saved. One there that can't be read (no permission, a disk error, not the store's JSON) reads
 *  every secret as unreadable, so nothing is minted over them, and no save writes over it this
 *  session; the next launch reads it again. A save refuses rather than move the file aside and
 *  start a new one: the next launch would find no display address and no agents' token in the new
 *  file and mint new ones, ending every screen's address and every agent's setup without a word,
 *  even when the cause had passed. */
let fileUnreadable = false;
/** The values decrypted so far, in the main process's memory only. */
const values = new Map<string, string>();
/** A decryption under way, so two asks for one entry reach the keychain once. */
const decrypting = new Map<string, Promise<SecretRead>>();
/** Entries this system could not decrypt: still on disk until replaced, but not saved for use,
 *  and not asked of the keychain again this session (each ask could be another prompt). */
const unreadable = new Set<string>();

const saved = (value: string): SecretRead => ({ state: "saved", value });
const ABSENT: SecretRead = { state: "absent" };
const UNREADABLE: SecretRead = { state: "unreadable" };

/** Whether this system can encrypt a secret. */
export async function canEncrypt(): Promise<boolean> {
  if (devOverride("TASTYTUNES_SECRETS_PLAIN") === "1") return false;
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

/** The file is there and couldn't be read: said in the log, and nothing writes over it. */
function cantRead(why: string): void {
  fileUnreadable = true;
  noteSaved(
    "error",
    `secrets.json couldn't be read (${why}), so no key or token is saved to it this session`,
  );
}

function load(): Map<string, Stored> {
  if (stored) return stored;
  stored = new Map();
  let text: string;
  try {
    text = readFileSync(filePath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") cantRead(errorMessage(e));
    return stored;
  }
  let parsed: unknown;
  try {
    // a byte-order mark first (an editor's save) is no reason to call the file unreadable
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    cantRead(errorMessage(e));
    return stored;
  }
  // the store has always written { v, entries }: anything else isn't one to read as empty
  if (!isRecord(parsed) || !isRecord(parsed.entries)) {
    cantRead(isRecord(parsed) ? "it held no entries" : `it held ${kindOf(parsed)}`);
    return stored;
  }
  for (const [name, e] of Object.entries(parsed.entries))
    if (isRecord(e) && typeof e.value === "string" && e.value)
      stored.set(name, { enc: e.enc === true, value: e.value });
  return stored;
}

/** An entry's value, decrypted the first time it is asked for. */
function valueOf(name: string): Promise<SecretRead> {
  const known = values.get(name);
  if (known != null) return Promise.resolve(saved(known));
  const e = load().get(name);
  if (!e) return Promise.resolve(fileUnreadable ? UNREADABLE : ABSENT);
  if (unreadable.has(name)) return Promise.resolve(UNREADABLE);
  if (!e.enc) {
    values.set(name, e.value);
    return Promise.resolve(saved(e.value));
  }
  let asked = decrypting.get(name);
  if (!asked) {
    asked = decrypt(name, e).finally(() => decrypting.delete(name));
    decrypting.set(name, asked);
  }
  return asked;
}

async function decrypt(name: string, e: Stored): Promise<SecretRead> {
  // saved again or forgotten while this was decrypting: the store's newer answer stands
  const newer = (): SecretRead => {
    const v = values.get(name);
    return v != null ? saved(v) : load().has(name) ? UNREADABLE : ABSENT;
  };
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
      Buffer.from(e.value, "base64"),
    );
    if (load().get(name) !== e) return newer();
    // nothing blank is ever saved, so a blank answer is a value that couldn't be read
    if (!result) {
      unreadable.add(name);
      return UNREADABLE;
    }
    values.set(name, result);
    // the keychain's key has moved on (rotated, or a stronger one is there): kept under the new one
    if (shouldReEncrypt) {
      load().set(name, { enc: true, value: await encrypt(result) });
      save();
    }
    return saved(result);
  } catch {
    if (load().get(name) !== e) return newer();
    // a value this system cannot decrypt (another machine's keychain, a reset keychain) is kept
    // as it is, and told apart from none saved: asked for again, never guessed at or minted over
    unreadable.add(name);
    return UNREADABLE;
  }
}

const encrypt = async (v: string): Promise<string> =>
  (await safeStorage.encryptStringAsync(v)).toString("base64");

/** Refuses while the file is there and couldn't be read (fileUnreadable): nothing writes over it. */
function writable(): void {
  load();
  if (fileUnreadable) throw new Error("secrets.json couldn't be read, so nothing is saved over it");
}

function save(): void {
  writable();
  const entries: Record<string, Stored> = {};
  for (const [name, e] of load()) entries[name] = e;
  // readable to its owner only from the first byte, the temporary file included; a filesystem
  // without modes (Windows) ignores it, and DPAPI's encryption is the protection there
  atomicWriteFileSync(filePath(), JSON.stringify({ v: 1, entries }), 0o600);
}

/** A secret's value, for the main process's own use; null when none is saved or it can't be read. */
export async function getSecret(name: SecretName): Promise<string | null> {
  const read = await valueOf(name);
  return read.state === "saved" ? read.value : null;
}

/** A secret's value, or whether none is saved or the saved one can't be read (SecretRead). */
export function readSecret(name: SecretName): Promise<SecretRead> {
  return valueOf(name);
}

/** Whether a secret is saved and usable, without decrypting it: one this system could not
 *  decrypt reads as unsaved once that is known. */
export function hasSecret(name: SecretName): boolean {
  return load().has(name) && !unreadable.has(name);
}

/** Save a secret, or forget it (null or blank); a rejection while the file couldn't be read. */
export async function setSecret(name: SecretName, value: string | null): Promise<void> {
  // refused before anything changes, so what is held stays what the file says
  writable();
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

/** What Settings may know of a secret: whether one is saved, its last four characters, and
 *  whether one is saved that couldn't be read. */
export async function secretHint(
  name: SecretName,
): Promise<{ saved: boolean; ends: string | null; unreadable: boolean }> {
  if (!load().has(name)) return { saved: false, ends: null, unreadable: fileUnreadable };
  const read = await valueOf(name);
  return read.state === "saved"
    ? { saved: true, ends: read.value.slice(-4), unreadable: false }
    : { saved: false, ends: null, unreadable: read.state === "unreadable" };
}

/** Whether saved secrets are encrypted here, asked without touching the keychain where it can
 *  be told otherwise: from what is stored, else macOS's Keychain and Windows' DPAPI are always
 *  there; only Linux has to ask whether a keyring is. */
export async function encryptsHere(): Promise<boolean> {
  if (devOverride("TASTYTUNES_SECRETS_PLAIN") === "1") return false;
  const saved = [...load().values()];
  if (saved.length > 0) return saved.every((e) => e.enc);
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return canEncrypt();
}
