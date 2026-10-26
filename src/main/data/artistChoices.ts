import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { app, dialog, nativeImage, type BrowserWindow } from "electron";
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

type Stored = ArtistChoice & { at: number };

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
      const at = (v as { at?: unknown }).at;
      out[k] = { ...own(v), at: typeof at === "number" ? at : 0 };
    }
    return out;
  },
});

export function choiceOf(name: string): ArtistChoice | null {
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

function sweepPicked(choices: Record<string, Stored>): void {
  const used = new Set(Object.values(choices).flatMap((c) => (c.kind === "file" ? [c.file] : [])));
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
 * An artist's chosen picture as an address to draw, or null. A cover is its address while an
 * album on its server still has it, else found again by its server and album title, since a
 * cover's address can move (the streamer's drive re-mints its pictures' addresses with every
 * standby); the address it was chosen at is the fallback. A file is its copy, or nothing once the
 * copy is gone.
 */
export function resolveChoice(
  name: string,
  pools: readonly MediaIndexPools[],
): { kind: ArtistChoice["kind"]; url: string } | null {
  const c = choiceOf(name);
  if (!c) return null;
  if (c.kind === "image") return { kind: c.kind, url: c.url };
  if (c.kind === "file")
    return pickedPath(c.file) ? { kind: c.kind, url: pickedUrl(c.file) } : null;
  const albums = pools.flatMap((g) =>
    c.serverUdn == null || g.udn === c.serverUdn ? g.albums : [],
  );
  // still where it was chosen (two editions of one title keep the one chosen)
  if (albums.some((a) => a.artUrl === c.url)) return { kind: c.kind, url: c.url };
  const title = c.album.trim().toLowerCase();
  const moved = albums.find((a) => a.title.trim().toLowerCase() === title && a.artUrl);
  return { kind: c.kind, url: moved?.artUrl ?? c.url };
}

/** The longest side a chosen file keeps: the artist page's picture at its largest, on Retina. */
const PICKED_MAX = 1200;

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
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty()) return "unreadable";
  const { width, height } = img.getSize();
  const scaled =
    Math.max(width, height) > PICKED_MAX
      ? img.resize(
          width >= height
            ? { width: PICKED_MAX, quality: "best" }
            : { height: PICKED_MAX, quality: "best" },
        )
      : img;
  const png = extname(path).toLowerCase() === ".png";
  const bytes = png ? scaled.toPNG() : scaled.toJPEG(90);
  if (bytes.length === 0) return "unreadable";
  const file = `${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}.${png ? "png" : "jpg"}`;
  mkdirSync(pickedDir(), { recursive: true });
  writeFileSync(join(pickedDir(), file), bytes);
  return { file, url: pickedUrl(file) };
}
