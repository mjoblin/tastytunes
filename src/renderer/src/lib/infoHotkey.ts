import { useStore } from "@/store";
import { openInfoForNowPlaying } from "@/lib/mediaInfo";

/**
 * ⌘I OPENS INFO FOR WHAT IS IN FRONT OF YOU (0.12.0, his word; Ctrl+I off the Mac; the Mac's
 * Get Info key). Info open, it closes. The Library showing an album, that album's Info; an
 * artist's page or folder, the artist's. Anywhere else (Now Playing, Display mode, the Queue,
 * the Library's lists, Presets…) the playing track's, with what the streamer says of the stream,
 * ‹ › stepping through the queue (lib/mediaInfo). Nothing playing and nothing on screen to ask
 * about, nothing. Rows take no part: none can be selected, and a pointer resting over a list
 * would beat the playing track.
 *
 * A screen with a subject of its own answers through one slot while it is mounted (the
 * Library), and only while it is the screen shown.
 */
let here: (() => boolean) | null = null;

/** The screen's subject: `open` opens its Info and says whether there was one. */
export function setInfoHere(open: () => boolean): () => void {
  here = open;
  return () => {
    if (here === open) here = null;
  };
}

export function toggleInfo(): void {
  const s = useStore.getState();
  if (s.mediaInfo) {
    s.setMediaInfo(null);
    return;
  }
  if (here && s.screen === "library" && !s.displayMode && here()) return;
  void openInfoForNowPlaying();
}
