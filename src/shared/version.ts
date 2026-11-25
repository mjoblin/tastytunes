/**
 * VERSION ORDER, pre-releases included (0.16.0-rc.8): semver's precedence, so 0.16.0-rc.7 is older
 * than 0.16.0-rc.8 and both are older than 0.16.0. The update checks compared only the three
 * numbers, so an rc's Check now said there was nothing newer when the next rc was out.
 */
type Parsed = { core: [number, number, number]; pre: string[] };

function parse(v: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Negative when `a` comes before `b`, positive after, 0 the same; null when either isn't a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  // a release comes after its pre-releases
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) - Number(q);
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether `candidate` is a later version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  return (compareVersions(candidate, current) ?? 0) > 0;
}
