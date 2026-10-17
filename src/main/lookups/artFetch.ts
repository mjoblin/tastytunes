import { knownServerHost } from "../media/upnpBrowser";
import { loggedFetch } from "../netlog";
import { allowed } from "./fetchGuard";

/**
 * A PICTURE, AND ONLY A PICTURE, FROM WHERE A PICTURE CAN COME (0.10.0, the whole-app
 * review). The renderer asks main for album art as a data URL (the scenes' palette, the
 * deck scenes' covers), and main used to fetch any http(s) URL and hand back whatever
 * came, which let a page that was not the app's read anything on the network through it.
 * Now a URL on a private or loopback address is fetched only when it is the streamer's or
 * a media server's the app knows (lookups/fetchGuard); an address on the internet is
 * fetched as before. A redirect is followed by hand so every hop is checked, the answer
 * must be a picture (by its type, or by its first bytes when a server calls it
 * octet-stream), and it is refused past the size limit before it is all read.
 * ONE HOME FOR EVERY PICTURE FETCH (the 0.11 re-score, 2026-10-13): the thumbnails behind
 * the tt-art scheme fetched their origin with a bare fetch, any URL, uncapped, and stored
 * whatever came; they now come through fetchPicture too, with their own limits.
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

/** A picture's type from its first bytes, for a server that calls every file octet-stream. */
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")))
    return "image/svg+xml";
  return null;
}

export interface PictureLimits {
  maxBytes: number;
  timeoutMs: number;
  headers?: Record<string, string>;
  /** Shown in the requests console (the renderer's own asks); the thumbnail cache's origin
   *  fetches are not, or a first browse would fill it. */
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
    const res = limits.logged ? await loggedFetch("art", url.href, init) : await fetch(url, init);
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
    const declared = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const type = declared.startsWith("image/") ? declared : sniff(bytes);
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
