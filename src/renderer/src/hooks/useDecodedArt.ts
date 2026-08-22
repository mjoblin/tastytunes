import { useEffect, useState } from "react";

/**
 * Holds the last DECODED art URL, advancing only once the next one has decoded
 * (or failed, or blown the cap). Every art surface should render from this, not
 * from the raw URL.
 *
 * Why: an <img src> and a CSS background-image both paint NOTHING until the
 * bytes arrive. Swapping the URL the instant a track changes therefore empties
 * the art tile AND drops the ambient wash to base black for however long the
 * fetch takes — half a second or more when the art comes from a remote service
 * via the streamer (AirPlay/Apple Music). Holding the previous art costs a beat
 * of staleness under the new track's text; blanking costs a full-window flash.
 * `useArtAccent` already works this way (it keeps the old accent until the new
 * one resolves) — this is the same discipline for the pixels.
 *
 * `capMs` bounds the hold: if the art never arrives we stop waiting and let the
 * surfaces show whatever the URL yields (usually the fallback panel), rather
 * than pinning the previous track's cover forever. `pending` is true while a
 * newer URL is still in flight.
 */
export function useDecodedArt(
  url: string | null | undefined,
  capMs = 2500,
): { art: string | null | undefined; pending: boolean } {
  const [shown, setShown] = useState<string | null | undefined>(url);
  useEffect(() => {
    // Nothing to wait for — an absent URL resolves to the fallback at once.
    if (!url) {
      setShown(url);
      return;
    }
    let done = false;
    const settle = (): void => {
      if (!done) {
        done = true;
        setShown(url);
      }
    };
    const probe = new Image();
    probe.onload = settle;
    probe.onerror = settle;
    probe.src = url;
    if (probe.complete) settle(); // already in the browser cache
    const cap = setTimeout(settle, capMs);
    return () => {
      done = true;
      clearTimeout(cap);
    };
  }, [url, capMs]);
  return { art: shown, pending: shown !== url };
}
