import { tt } from "@/api";

/** The waits before asking again: a beat, then a longer one. */
const AGAIN_MS = [3000, 10000];

/**
 * A COVER THROUGH MAIN, ASKED AGAIN WHEN MAIN COULD NOT ANSWER (0.13.0-rc.5, his rc.4: "the art
 * wash isn't working anymore"). The wash and the accent fetch the playing cover once per track
 * and kept a failed fetch for the whole track, so a refusal in the app's first seconds (a cover on
 * a media server the streamer had not yet listed) left the wash off until the next track. Main
 * now waits for that listing (ipc/lookups' fetchArt); this asks again after a beat and after a
 * longer one for anything else passing, and answers null only when all three found nothing. A
 * caller keeps that null for the session no more than any other failure: it is not an answer
 * about the cover. `live` says whether the caller still wants it.
 */
export async function fetchArtSoon(
  url: string,
  live: () => boolean,
): Promise<{ dataUrl: string } | null> {
  for (let i = 0; i <= AGAIN_MS.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, AGAIN_MS[i - 1]));
    if (!live()) return null;
    const art = await tt.fetchArt(url).catch(() => null);
    if (art) return art;
  }
  return null;
}
