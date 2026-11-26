/**
 * A PICTURE THAT FAILS IS ASKED FOR AGAIN before the failure is believed (components/media/ArtImage,
 * hooks/useArtLoadable): twice, a beat apart, with a query the browser hasn't seen so it asks the
 * server rather than hand back the failure. A server's picture (http, https) is retried, and so is
 * the display server's own (/art/<id>, on the page another screen opens), which keeps no failure,
 * so a second ask can work; a data URL, a blob or the thumbnail cache's never is.
 */
export const ART_RETRY_MS = [1500, 4000] as const;

/** Whether a failed picture is worth asking for again. */
export const artRetriable = (url: string): boolean =>
  /^https?:/i.test(url) || url.startsWith("/art/");

/** The address of the `n`th retry (0 is the first ask, as it is). */
export const artRetryUrl = (url: string, n: number): string =>
  n > 0 && artRetriable(url) ? `${url}${url.includes("?") ? "&" : "?"}tt_retry=${n}` : url;
