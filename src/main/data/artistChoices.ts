import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { app, dialog, nativeImage, type BrowserWindow, type NativeImage } from "electron";
import { PICKED_ART } from "@shared/artUrl";
import { isRecord } from "@shared/guards";
import type { ArtistChoice, MediaIndexPools } from "@shared/model";
import { jsonFileStore } from "./jsonStore";

// ARTISTS' CHOSEN PICTURES (0.13.0 round 7; shared/model ArtistChoice says what a choice is and
// why). One small JSON beside settings.json, an artist's name (lowercased) to their choice, and
// a folder of the picture files people chose, each copied in under a name made from its bytes, so
// moving or deleting the original loses nothing. A choice is never replaced but by another, or
// cleared (decisions/0013). Every other picture yields to it: main's answer for the rows and cards
// (ipc/lookups artistPictures) and every window's map of them (artistChoices) both read resolveChoice.
//
// EVERY CHOSEN PICTURE KEPT (0.14.0, his word 2026-10-30: "yes, build it, covers too"): a picture
// chosen from Wikipedia, Commons, fanart.tv or an album's cover is copied into the same folder
// (lookups/choiceCopies), its file named on the choice as `copy`, and drawn from there, so a
// source that drops or renames it, or an album that leaves the library, changes nothing; it had
// kept only the address, and once the caches let the picture go the page fell back to another.

type Stored = ArtistChoice & {
  at: number;
  /** The copy kept in the app's data, once made: a picture's or a cover's. */
  copy?: string;
};
/** A choice as kept: when it was made, and its copy. */
export type StoredChoice = Stored;

const keyOf = (name: string): string => name.trim().toLowerCase();

/** The folder the chosen picture files are copied into. */
const pickedDir = (): string => join(app.getPath("userData"), "artist-pictures");

/** A copied file's name: its bytes' hash, and its kind. */
const FILE_NAME = /^[0-9a-f]{24}\.(jpg|png)$/;

/** The address a copied file is drawn from (app/artProtocol serves it). */
export const pickedUrl = (file: string): string => `${PICKED_ART}${file}`;

/** The copied file behind a picked name, or null for a name that is not one of ours. */
export function pickedPath(file: string): string | null {
  if (!FILE_NAME.test(file)) return null;
  const path = join(pickedDir(), file);
  return existsSync(path) ? path : null;
}

/** Whether something sent from a window is a choice the app could have made. */
export function isArtistChoice(x: unknown): x is ArtistChoice {
  if (!isRecord(x)) return false;
  const web = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u);
  if (x.kind === "image") return web(x.url);
  if (x.kind === "cover")
    return (
      web(x.url) &&
      typeof x.album === "string" &&
      x.album.length > 0 &&
      (x.serverUdn === null || typeof x.serverUdn === "string")
    );
  if (x.kind === "file") return typeof x.file === "string" && pickedPath(x.file) != null;
  return false;
}

/** A choice with only its own fields (what a window sent, or the file held, may carry more). */
function own(c: ArtistChoice): ArtistChoice {
  if (c.kind === "image") return { kind: c.kind, url: c.url };
  if (c.kind === "file") return { kind: c.kind, file: c.file };
  return { kind: c.kind, url: c.url, album: c.album, serverUdn: c.serverUdn };
}

const store = jsonFileStore<Record<string, Stored>>({
  pathOf: () => join(app.getPath("userData"), "artist-choices.json"),
  scope: "artist-choices",
  load: (parsed) => {
    const out: Record<string, Stored> = {};
    if (!isRecord(parsed)) return out;
    for (const [k, v] of Object.entries(parsed)) {
      if (!isArtistChoice(v)) continue;
      const { at, copy } = v as { at?: unknown; copy?: unknown };
      out[k] = {
        ...own(v),
        at: typeof at === "number" ? at : 0,
        ...(v.kind !== "file" && typeof copy === "string" && FILE_NAME.test(copy) ? { copy } : {}),
      };
    }
    return out;
  },
});

export function choiceOf(name: string): StoredChoice | null {
  return store.get()[keyOf(name)] ?? null;
}

/** Every artist with a choice, by name lowercased. */
export function choiceKeys(): string[] {
  return Object.keys(store.get());
}

/** Choose an artist's picture, or clear it (null); the files no choice names go, unless picked
 *  in the last hour (a chooser still open may be about to use one). */
export function setChoice(name: string, choice: ArtistChoice | null): void {
  const k = keyOf(name);
  if (!k) return;
  const next = { ...store.get() };
  if (choice) next[k] = { ...own(choice), at: Date.now() };
  else delete next[k];
  store.set(next);
  sweepPicked(next);
}

/** The copy kept for a choice, named on it when the choice is still the one made at `at` (a
 *  choice made again while its copy was fetched keeps waiting for its own); false when not. */
export function setCopy(name: string, at: number, file: string): boolean {
  const k = keyOf(name);
  const c = store.get()[k];
  if (!c || c.kind === "file" || c.at !== at || !pickedPath(file)) return false;
  const next = { ...store.get(), [k]: { ...c, copy: file } };
  store.set(next);
  sweepPicked(next);
  return true;
}

/** Whether a choice's copy is kept: a file's always is, a picture's or a cover's once made. */
export function copyKept(c: StoredChoice): boolean {
  return c.kind === "file" || (c.copy != null && pickedPath(c.copy) != null);
}

function sweepPicked(choices: Record<string, Stored>): void {
  const used = new Set(
    Object.values(choices).flatMap((c) => (c.kind === "file" ? [c.file] : c.copy ? [c.copy] : [])),
  );
  let files: string[];
  try {
    files = readdirSync(pickedDir());
  } catch {
    return;
  }
  for (const f of files) {
    if (used.has(f) || !FILE_NAME.test(f)) continue;
    const path = join(pickedDir(), f);
    try {
      if (Date.now() - statSync(path).mtimeMs > 3_600_000) rmSync(path);
    } catch {
      // gone already
    }
  }
}

/**
 * An artist's chosen picture as an address to draw (`url`, its kept copy once there is one) and
 * the address the chooser offered it at (`offered`, which its tile is found by), or null. A
 * cover's offered address is its own while an album on its server still has it, else found
 * again by its server and album title, since a cover's address can move (the streamer's drive
 * re-mints its pictures' addresses with every standby); the address it was chosen at is the
 * fallback. A file is its copy, or nothing once the copy is gone.
 */
export function resolveChoice(
  name: string,
  pools: readonly MediaIndexPools[],
): { kind: ArtistChoice["kind"]; url: string; offered: string } | null {
  const c = choiceOf(name);
  if (!c) return null;
  if (c.kind === "file") {
    const url = pickedUrl(c.file);
    return pickedPath(c.file) ? { kind: c.kind, url, offered: url } : null;
  }
  const offered = c.kind === "image" ? c.url : coverNow(c, pools);
  const kept = c.copy && pickedPath(c.copy) ? pickedUrl(c.copy) : null;
  return { kind: c.kind, url: kept ?? offered, offered };
}

/** A chosen cover's address now: where it was chosen while an album there has it, else its
 *  album's found again on its server, else the address it was chosen at. */
function coverNow(
  c: Extract<ArtistChoice, { kind: "cover" }>,
  pools: readonly MediaIndexPools[],
): string {
  const albums = pools.flatMap((g) =>
    c.serverUdn == null || g.udn === c.serverUdn ? g.albums : [],
  );
  // still where it was chosen (two editions of one title keep the one chosen)
  if (albums.some((a) => a.artUrl === c.url)) return c.url;
  const title = c.album.trim().toLowerCase();
  return albums.find((a) => a.title.trim().toLowerCase() === title && a.artUrl)?.artUrl ?? c.url;
}

/** The longest side a chosen file keeps: the artist page's picture at its largest, on Retina. */
export const PICKED_MAX = 1200;

/**
 * A picture file to choose: the open dialog, then the file copied in, no larger than the page
 * draws it, as a JPEG (a PNG keeps its transparency). JPEG and PNG only, the two Electron's
 * nativeImage reads everywhere; "unreadable" when the file would not open as a picture, null when
 * cancelled.
 */
export async function pickPictureFile(
  parent: BrowserWindow | null,
): Promise<{ file: string; url: string } | "unreadable" | null> {
  const opts = {
    title: "Choose a picture",
    buttonLabel: "Choose",
    properties: ["openFile" as const],
    filters: [{ name: "Pictures", extensions: ["jpg", "jpeg", "png"] }],
  };
  const got = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  const path = got.canceled ? null : got.filePaths[0];
  if (!path) return null;
  const file = keepPicture(
    nativeImage.createFromPath(path),
    extname(path).toLowerCase() === ".png",
  );
  return file ? { file, url: pickedUrl(file) } : "unreadable";
}

/** A picture copied into the folder, no larger than the page draws it, as a JPEG (a PNG keeps
 *  its transparency): its file's name, or null when it isn't a picture. A chosen file's and a
 *  chosen picture's or cover's copy alike (lookups/choiceCopies). */
export function keepPicture(img: NativeImage, png: boolean): string | null {
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const scaled =
    Math.max(width, height) > PICKED_MAX
      ? img.resize(
          width >= height
            ? { width: PICKED_MAX, quality: "best" }
            : { height: PICKED_MAX, quality: "best" },
        )
      : img;
  const bytes = png ? scaled.toPNG() : scaled.toJPEG(90);
  if (bytes.length === 0) return null;
  const file = `${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}.${png ? "png" : "jpg"}`;
  mkdirSync(pickedDir(), { recursive: true });
  writeFileSync(join(pickedDir(), file), bytes);
  return file;
}
