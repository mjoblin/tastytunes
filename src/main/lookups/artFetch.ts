import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { loggedFetch } from "../netlog";

/**
 * A PICTURE, AND ONLY A PICTURE, FROM WHERE A PICTURE CAN COME (0.10.0, the whole-app
 * review). The renderer asks main for album art as a data URL (the scenes' palette, the
 * deck scenes' covers), and main used to fetch any http(s) URL and hand back whatever
 * came, which let a page that was not the app's read anything on the network through it.
 * Now a URL on a private or loopback address is fetched only when it is the streamer's or
 * a media server's the app knows (every piece of art on the network comes from one of
 * those); an address on the internet (a station's logo, a cover archive) is fetched as
 * before. A redirect is followed by hand so every hop is checked, the answer must be a
 * picture (by its type, or by its first bytes when a server calls it octet-stream), and it
 * is refused past the size limit before it is all read.
 */
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 3;

const PRIVATE_V4 = [
  [10, 0, 0, 0, 8],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 168, 0, 0, 16],
  [100, 64, 0, 0, 10],
  [0, 0, 0, 0, 8],
];

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    const n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
    return PRIVATE_V4.some(([a, b, c, d, bits]) => {
      const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
      const mask = (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) === (base & mask);
    });
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return privateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/** Whether `url` may be fetched: http(s), and on a private address only for a trusted host. */
async function allowed(url: URL, trusted: (hostname: string) => boolean): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (trusted(host)) return true;
  if (isIP(host)) return !privateAddress(host);
  // a name only the local network resolves is the local network
  if (host === "localhost" || host.endsWith(".local") || !host.includes(".")) return false;
  try {
    const found = await lookup(host, { all: true });
    return found.length > 0 && !found.some((a) => privateAddress(a.address));
  } catch {
    return false;
  }
}

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

export async function fetchArtDataUrl(
  raw: string,
  trusted: (hostname: string) => boolean,
): Promise<{ dataUrl: string } | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const signal = AbortSignal.timeout(5000);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await allowed(url, trusted))) return null;
    const res = await loggedFetch("art", url.href, { signal, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return null;
      url = new URL(next, url);
      continue;
    }
    if (!res.ok || !res.body) return null;
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      // a fetch body's chunks are bytes; node's typings leave the stream's element untyped
      const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (done || !value) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks);
    const declared = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const type = declared.startsWith("image/") ? declared : sniff(buf);
    if (!type) return null;
    return { dataUrl: `data:${type};base64,${buf.toString("base64")}` };
  }
  return null;
}
