import { knownServerHost } from "../media/upnpBrowser";
import { loggedFetch } from "../netlog";
import { allowed, localOnly } from "./fetchGuard";
import { mediaType } from "@shared/keys";
import { pictureType } from "@shared/pictureType";

/**
 * A PICTURE, AND ONLY A PICTURE, FROM WHERE A PICTURE CAN COME (0.10.0). The renderer asks
 * main for album art as a data URL (the scenes' palette, the deck scenes' covers), and main
 * used to fetch any http(s) URL and hand back whatever came, which let a page that was not
 * the app's read anything on the network through it.
 * Now a URL on a private or loopback address is fetched only when it is the streamer's or
 * a media server's the app knows (lookups/fetchGuard); an address on the internet is
 * fetched as before. A redirect is followed by hand so every hop is checked, the answer
 * must be a picture (by its type, or by its first bytes when a server calls it
 * octet-stream), and it is refused past the size limit before it is all read.
 * ONE HOME FOR EVERY PICTURE FETCH: the thumbnails behind the tt-art scheme fetched their
 * origin with a bare fetch, any URL, uncapped, and stored whatever came; they now come
 * through fetchPicture too, with their own limits.
 */

/** The hosts on the local network a picture may come from: the streamer, and the media
 *  servers the app knows. */
export function artHostTrust(streamer: string | null): (hostname: string) => boolean {
  let own: string | null = null;
  try {
    own = streamer ? new URL(`http://${streamer}`).hostname.replace(/^\[|\]$/g, "") : null;
  } catch {
    own = null;
  }
  return (hostname) => (own != null && hostname === own) || knownServerHost(hostname);
}

const MAX_REDIRECTS = 3;

export interface PictureLimits {
  maxBytes: number;
  timeoutMs: number;
  headers?: Record<string, string>;
  /** Shown in the requests console (the renderer's own asks); the thumbnail cache's origin
   *  fetches on the local network are not, or a first browse would fill it. A hop to the
   *  internet always is. */
  logged: boolean;
}

/** A picture from `raw`, checked at every hop, capped, and typed; null for anything else. */
export async function fetchPicture(
  raw: string,
  trusted: (hostname: string) => boolean,
  limits: PictureLimits,
): Promise<{ bytes: Buffer; type: string } | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const init: RequestInit = { signal, redirect: "manual", headers: limits.headers };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await allowed(url, trusted))) return null;
    // a hop that leaves the local network is always logged: the requests console lists every
    // request to the internet (0.16.0 left the thumbnail cache's origin fetches out of it)
    const res =
      limits.logged || !localOnly(url.hostname)
        ? await loggedFetch("art", url.href, init)
        : await fetch(url, init);
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return null;
      url = new URL(next, url);
      continue;
    }
    if (!res.ok || !res.body) return null;
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > limits.maxBytes) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      // a fetch body's chunks are bytes; node's typings leave the stream's element untyped
      const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (done || !value) break;
      total += value.byteLength;
      if (total > limits.maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    const declared = mediaType(res.headers.get("content-type"));
    const type = declared.startsWith("image/") ? declared : pictureType(bytes);
    if (!type) return null;
    return { bytes, type };
  }
  return null;
}

/** The renderer's ask: a picture as a data URL, small and quick. */
export async function fetchArtDataUrl(
  raw: string,
  trusted: (hostname: string) => boolean,
): Promise<{ dataUrl: string } | null> {
  const got = await fetchPicture(raw, trusted, {
    maxBytes: 3_000_000,
    timeoutMs: 5000,
    logged: true,
  });
  return got ? { dataUrl: `data:${got.type};base64,${got.bytes.toString("base64")}` } : null;
}
