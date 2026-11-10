import { nativeImage } from "electron";
import { isDeviceArt, wikiThumbAt } from "@shared/artUrl";
import type { MediaIndexPools } from "@shared/model";
import {
  choiceOf,
  copyKept,
  keepAsItCame,
  keepPicture,
  PICKED_MAX,
  resolveChoice,
  setCopy,
} from "../data/artistChoices";
import { artHostTrust } from "./artFetch";
import { fetchOriginInTurn } from "./artThumbs";
import { nameKey } from "@shared/keys";

/**
 * A CHOSEN PICTURE'S COPY (0.14.0; his question 2026-10-30, "what happens if that source no
 * longer has that image?", and his word, "yes, build it, covers too"). A picture chosen from
 * Wikipedia, Commons or fanart.tv, or an album's cover, kept only its address: once the
 * thumbnail cache and Chromium's had let it go, an address that no longer answered left the
 * artist page on the next picture down, a change nobody asked for (decisions/0013). Now the
 * picture is copied into the app's data when it is chosen (data/artistChoices keepPicture, as a
 * chosen file is), at the page's largest size, and drawn from the copy. A choice made before
 * this has its copy made the next time a window reads the choices (ipc/lookups artistChoices),
 * in the background; a cover's then from its address now, found again by its album once the
 * index has it. A picture from the web is fetched only with the artist lookups on ("off = no
 * requests"); its copy draws either way, since drawing it asks nothing.
 */

/** How long a copy that could not be made from an address waits to be tried from it again (a
 *  source that didn't answer). A cover's address found again by the index is a new one, tried at
 *  once. */
const RETRY_MS = 10 * 60_000;

const making = new Map<string, Promise<boolean>>();
const failedAt = new Map<string, number>();

export interface CopyContext {
  pools: readonly MediaIndexPools[];
  /** The artist lookups are on. */
  photos: boolean;
  /** The streamer's host: its own art server is trusted and asked one picture at a time. */
  streamer: string | null;
}

/** Makes the copy of the picture chosen for `name` when it has none: true once it is kept. One
 *  attempt at a time per choice, and an address that failed waits RETRY_MS. */
export function keepChoiceCopy(name: string, ctx: CopyContext): Promise<boolean> {
  const c = choiceOf(name);
  if (!c) return Promise.resolve(false);
  if (copyKept(c)) return Promise.resolve(true);
  if (c.kind === "image" && !ctx.photos) return Promise.resolve(false);
  const id = `${nameKey(name)}|${c.at}`;
  const pending = making.get(id);
  if (pending) return pending;
  const offered = resolveChoice(name, ctx.pools)?.offered;
  if (!offered) return Promise.resolve(false);
  const tried = `${id}|${offered}`;
  if (Date.now() - (failedAt.get(tried) ?? -Infinity) < RETRY_MS) return Promise.resolve(false);
  const run = copy(name, c.at, offered, ctx)
    .catch(() => false)
    .then((kept) => {
      if (kept) failedAt.delete(tried);
      else failedAt.set(tried, Date.now());
      return kept;
    })
    .finally(() => making.delete(id));
  making.set(id, run);
  return run;
}

async function copy(name: string, at: number, offered: string, ctx: CopyContext): Promise<boolean> {
  const trusted = artHostTrust(ctx.streamer);
  const device = isDeviceArt(offered, ctx.streamer);
  // a Wikipedia image is offered at the article's 330 wide: the page's largest is asked for
  // first, the address offered if Wikimedia has no larger one
  for (const url of [wikiThumbAt(offered, PICKED_MAX / 2), offered]) {
    if (!url) continue;
    const got = await fetchOriginInTurn(url, trusted, device);
    if (!got) continue;
    // a picture nativeImage can't read (a WebP or GIF cover, an SVG) is kept as it came
    const img = nativeImage.createFromBuffer(got.raw);
    const file = img.isEmpty()
      ? keepAsItCame(got.raw, got.type)
      : keepPicture(img, got.type === "image/png");
    if (file) return setCopy(name, at, file);
  }
  return false;
}
