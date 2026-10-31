import { Lru } from "@/lib/lru";

/**
 * THE COVERS LATELY SHOWN STAY IN THE WINDOW (0.13.0-rc.4, his question: a grid's covers loaded,
 * scrolled far down and back, and the top's covers showed their loaders again). The windowed grids
 * drop the cards off screen, and a card that came back asked for its picture again. Pictures the
 * app sizes itself come back quickly from main's disk cache, but a media server that sizes its
 * own (Asset, his: artSrc leaves its sized URLs alone) sends them with no caching headers, so the
 * window asked the server again and it resized again, about 350 ms a picture, the last of the
 * top's four on his library 2.5 s behind the cards passed on the way. The last KEEP_ART pictures
 * shown stay referenced here, so a card that comes back finds its picture already in the window,
 * and a picture shown once this session never shows the loader again.
 *
 * What it costs is the pictures as they came, a card's cover about 36 KB on his library (60 KB at
 * the 90th percentile): about 40 MB when full (60 MB were every cover a large one), whatever the
 * library's size, since the oldest goes as a new one comes, and only card-sized pictures are kept. On his library, all 352 covers kept moved the window's memory less than the
 * runs differed by; the decoded pixels are the browser's to keep or drop, as for any picture off
 * screen.
 */
export const KEEP_ART = 1000;

/**
 * ONLY A CARD-SIZED PICTURE IS KEPT (his question: "does this require the media server to resize
 * art? ... i just want to make sure we're not setting some users up for a giant memory hog"). A
 * card's cover arrives at 480 px whoever the server is (Asset sizes its own, the app's thumbnail
 * cache every other's), but a picture the resizer cannot read passes as it came (stored up to
 * 2 MB, up to 20 MB shown once) and an artist picture chosen from a file is kept at up to 1,200
 * px; neither is kept here, so the keep's worst is a thousand card-sized pictures.
 */
export const KEEP_ART_MAX_PX = 640;

/** A picture of this natural size is card-sized, and so worth keeping (unit-tested). */
export const keepable = (width: number, height: number): boolean =>
  width > 0 && height > 0 && Math.max(width, height) <= KEEP_ART_MAX_PX;

const kept = new Lru<string, HTMLImageElement>(KEEP_ART);
/** The pictures shown this session, by URL, for the loader: names only, so its cap is generous
 *  (20,000 at about 150 bytes each, some 3 MB). */
const shown = new Lru<string, true>(20_000);

/** Keep a picture that has just been shown, at its natural size: the newest kept, the oldest let
 *  go past KEEP_ART; one larger than a card is remembered as shown but not kept. */
export function keepArt(src: string, width: number, height: number): void {
  // inline and object-URL pictures are already in the page's hands
  if (src.startsWith("data:") || src.startsWith("blob:")) return;
  shown.set(src, true);
  if (!keepable(width, height)) return;
  if (kept.get(src)) return;
  const img = new Image();
  img.src = src;
  kept.set(src, img);
}

/** The picture was shown before this session: its card shows no loader while it comes back. */
export const shownBefore = (src: string): boolean => shown.has(src);
