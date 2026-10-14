import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * WHERE A PICTURE MAY BE FETCHED FROM (0.10.0, the whole-app review; one home since the 0.11
 * re-score). A URL on a private or loopback address is fetched only when it is the streamer's
 * or a media server's the app knows; an address on the internet (a station's logo, a cover
 * archive, a Wikipedia photo) is fetched. Every fetch of a picture, the data URLs the renderer
 * asks for and the thumbnails behind the tt-art scheme alike, asks here (lookups/artFetch).
 * Pure but for the DNS lookup, which a test can replace.
 */

const PRIVATE_V4 = [
  [0, 0, 0, 0, 8],
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 168, 0, 0, 16],
  [224, 0, 0, 0, 4],
  [240, 0, 0, 0, 4],
];

function privateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  const n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  return PRIVATE_V4.some(([a, b, c, d, bits]) => {
    const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  });
}

/** An IPv6 address as its eight 16-bit groups, "::" expanded and a dotted IPv4 tail read; null
 *  when it is not one. Reading the groups, never the spelling, is the point: the URL parser
 *  writes [::ffff:127.0.0.1] as ::ffff:7f00:1, which a prefix test on the text let through as
 *  a public address (the 0.11 re-score, 2026-10-13). */
export function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (isIP(dotted[1]) !== 4) return null;
    const p = dotted[1].split(".").map(Number);
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    s = s.slice(0, -dotted[1].length);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const read = (h: string): number[] =>
    h === "" ? [] : h.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = read(halves[0]);
  const rest = halves.length === 2 ? read(halves[1]) : [];
  const fill = 8 - head.length - rest.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [
    ...head,
    ...new Array<number>(halves.length === 2 ? fill : 0).fill(0),
    ...rest,
    ...tail,
  ];
  return groups.length === 8 && groups.every((n) => Number.isInteger(n)) ? groups : null;
}

/** Whether an address is one the internet does not reach (loopback, private, link-local,
 *  multicast, reserved), an IPv4 address carried inside IPv6 judged as that IPv4 address. An
 *  address it cannot read counts as private, so it is refused. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const g = v6Groups(ip);
  if (!g) return true;
  const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  const zero5 = g.slice(0, 5).every((n) => n === 0);
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d); :: and ::1 too
  if (zero5 && g[5] === 0xffff) return privateV4(v4);
  if (zero5 && g[5] === 0) return (g[6] === 0 && g[7] <= 1) || privateV4(v4);
  // NAT64 (64:ff9b::/96) reaches the IPv4 address it carries
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return privateV4(v4);
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local, fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local, fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local, fec0::/10 (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

type Resolve = (host: string) => Promise<{ address: string }[]>;
const resolveAll: Resolve = (host) => lookup(host, { all: true });

/** Whether `url` may be fetched: http(s), and on a private address only for a trusted host. */
export async function allowed(
  url: URL,
  trusted: (hostname: string) => boolean,
  resolve: Resolve = resolveAll,
): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (trusted(host)) return true;
  if (isIP(host)) return !privateAddress(host);
  // a name only the local network resolves is the local network
  if (host === "localhost" || host.endsWith(".local") || !host.includes(".")) return false;
  try {
    const found = await resolve(host);
    return found.length > 0 && !found.some((a) => privateAddress(a.address));
  } catch {
    return false;
  }
}
