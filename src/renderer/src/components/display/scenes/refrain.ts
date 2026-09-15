import type { Scene, SceneFrame, SceneKey, SceneSettingDef, SceneSettings } from "./types";
import { easeTowards } from "../clock";
import { typePx } from "../type";
import { clamp, easeOutCubic, ellipsize, rgb, rgba, setFont } from "./lib";

/**
 * REFRAIN. The song's lines as rows, and the path the singing takes through
 * them. A chorus is the lines that come back: every distinct line is one row,
 * in the order it is first sung, so a verse walks down new rows and a chorus
 * loops back up to rows already there. Down the left runs the path so far,
 * a straight step for the next new line and an arc for a return, the arc
 * wider the further back it reaches. The row being sung is lit, the line
 * sung most often (the hook) is drawn largest and in gold, and dots after a
 * row count the times it has been sung so far. By the end the screen holds
 * the song's shape as a map of its phrases. Nothing here comes from the
 * audio but the swell of the lit row on a kick; the map is the words'
 * own. Without lyrics the title stands alone.
 *
 * Lines are matched by their words (case, punctuation and spacing dropped),
 * so a line sung again with one word changed is a new row — the honesty line
 * says so. Songs with more rows than fit are shown through a window that
 * follows the singing.
 */
export const REFRAIN_KEY: SceneKey = {
  reads: [
    { shows: "A row", means: "One line of the song, in the order first sung." },
    { shows: "The lit row", means: "The line being sung." },
    { shows: "The largest row", means: "The line sung most often, in gold." },
    {
      shows: "The path down the left",
      means:
        "Where the song has been: a step down for a new line, an arc back up for one that returns.",
    },
    { shows: "Dots after a row", means: "How many times it has been sung so far." },
    { shows: "A brighter row", means: "A line sung more often. Each singing adds a little." },
  ],
  honesty: [
    "Lines are matched by their words, so a line sung again with one word changed counts as a new line.",
  ],
};
export const REFRAIN_SETTINGS: SceneSettingDef[] = [
  { key: "path", label: "Path", kind: "toggle", default: true },
  { key: "marks", label: "Marks", kind: "toggle", default: true },
  // the Motion switch holds the rows still (user, 2026-09-15): no slide on arrival, no swell
  // on a kick, no easing of the light or the window; the map still changes as lines are sung
  { key: "motion", label: "Motion", kind: "toggle", default: true },
];

/** The lyric's shape: each distinct line once, in first-sung order, and every line's row. */
interface Built {
  lines: readonly { t: number; text: string }[];
  rows: { text: string; count: number }[];
  /** Line index → row, or -1 for a line without words (an intro, a gap). */
  rowOf: Int16Array;
  /** The row sung most often; -1 when no row repeats. */
  hook: number;
}

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();

function build(lines: readonly { t: number; text: string }[]): Built {
  const rows: { text: string; count: number }[] = [];
  const index = new Map<string, number>();
  const rowOf = new Int16Array(lines.length).fill(-1);
  lines.forEach((ln, i) => {
    const key = normalize(ln.text);
    if (!key) return;
    let r = index.get(key);
    if (r == null) {
      r = rows.length;
      index.set(key, r);
      rows.push({ text: ln.text.trim(), count: 0 });
    }
    rows[r].count++;
    rowOf[i] = r;
  });
  let hook = -1;
  let most = 1;
  rows.forEach((row, r) => {
    if (row.count > most) {
      most = row.count;
      hook = r;
    }
  });
  return { lines, rows, rowOf, hook };
}

const ARRIVE = 0.45;
const STEP = 0.4;
/** A path segment fades in over this long (user, 2026-09-15: they popped). */
const FADE = 0.35;
/** Without lyrics the title waits this long before it shows, so a track change (a moment
 *  with no words while the new track's lyrics load) never flashes the title full screen. */
const TITLE_WAIT = 1.5;

export class Refrain implements Scene {
  settings: SceneSettings = {};
  private built: Built | null = null;
  /** Per row: how lit it is (eased toward 1 while sung, back toward a rest level after). */
  private lit = new Float32Array(0);
  /** The window's first row, eased so the map slides rather than jumps. */
  private top = 0;
  private lastLine = -1;
  private since = 0;
  private punch = 0;
  private punchAim = 0;
  /** When each line's step of the path first drew (ms), NaN until it does; cleared past a
   *  seek back so a step re-arrives with its fade. */
  private stepAt = new Float64Array(0);
  private titleFor: string | null = null;
  private titleSince = 0;

  private shape(f: SceneFrame): Built | null {
    const lines = f.lyric?.lines ?? null;
    if (!lines || lines.length === 0) {
      this.built = null;
      return null;
    }
    if (!this.built || this.built.lines !== lines) {
      this.built = build(lines);
      this.lit = new Float32Array(this.built.rows.length);
      this.stepAt = new Float64Array(lines.length).fill(NaN);
      this.lastLine = -1;
      this.top = 0;
    }
    return this.built;
  }

  draw(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    const { w, h, palette: P } = f;
    ctx.fillStyle = rgb(P.bg);
    ctx.fillRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(
      w * 0.5,
      h * 0.5,
      0,
      w * 0.5,
      h * 0.5,
      Math.max(w, h) * 0.6,
    );
    glow.addColorStop(0, rgba(P.accent[0], 0.04 + 0.1 * f.loud));
    glow.addColorStop(1, rgba(P.accent[0], 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    const built = this.shape(f);
    ctx.textBaseline = "middle";
    if (!built || built.rows.length === 0) {
      // no words: the title, modest and dim with the artist beneath, and only after a wait —
      // a track change has a wordless moment while the new lyrics load, and a full-screen
      // title flashing there distracted (user, 2026-09-15)
      if (f.title !== this.titleFor) {
        this.titleFor = f.title;
        this.titleSince = f.now;
      }
      const waited = (f.now - this.titleSince) / 1000;
      if (f.title && waited >= TITLE_WAIT) {
        const px = typePx(f, "body") * 1.2;
        const k = f.reduced ? 1 : easeOutCubic((waited - TITLE_WAIT) / 0.6);
        setFont(ctx, 600, px, f.font);
        ctx.fillStyle = rgba(P.dim, 0.9 * k);
        ctx.textAlign = "center";
        ctx.fillText(ellipsize(ctx, f.title, w * 0.8), w / 2, h * 0.47);
        if (f.subtitle) {
          setFont(ctx, 400, px * 0.7, f.font);
          ctx.fillStyle = rgba(P.faint, 0.9 * k);
          ctx.fillText(ellipsize(ctx, f.subtitle, w * 0.8), w / 2, h * 0.47 + px * 1.3);
        }
        ctx.textAlign = "start";
      }
      return;
    }

    // the kick's swell on the lit row, like Type's
    this.punchAim = easeTowards(this.punchAim, 0, f.dt, 0.12);
    if (f.hitsKnown)
      for (const hit of f.hits)
        if (hit.type === "kick") this.punchAim = Math.max(this.punchAim, hit.strength);
    this.punch = easeTowards(this.punch, this.punchAim, f.dt, 0.06);

    const still = f.reduced || this.settings.motion === false;
    const lineIndex = f.lyric?.index ?? -1;
    if (lineIndex !== this.lastLine) {
      // a seek back clears the steps past the new line, so they fade in again when re-sung
      if (lineIndex < this.lastLine)
        for (let i = lineIndex + 1; i < this.stepAt.length; i++) this.stepAt[i] = NaN;
      this.lastLine = lineIndex;
      this.since = f.now;
    }
    const current = lineIndex >= 0 && lineIndex < built.rowOf.length ? built.rowOf[lineIndex] : -1;
    const age = (f.now - this.since) / 1000;
    const arrive = still ? 1 : easeOutCubic(age / ARRIVE);

    // how many times each row has been sung SO FAR, and the path so far
    const sungSoFar = new Uint16Array(built.rows.length);
    const path: number[] = [];
    const stepLine: number[] = [];
    for (let i = 0; i <= lineIndex && i < built.rowOf.length; i++) {
      const r = built.rowOf[i];
      if (r < 0) continue;
      sungSoFar[r]++;
      path.push(r);
      stepLine.push(i);
      if (Number.isNaN(this.stepAt[i])) this.stepAt[i] = f.now;
    }
    // a step's fade-in, from the moment it first drew
    const fadeOf = (k: number): number =>
      still ? 1 : easeOutCubic((f.now - this.stepAt[stepLine[k]]) / 1000 / FADE);

    // the lit state eases: the current row up to 1, a sung row back to a rest level that
    // rises a little with every singing (user, 2026-09-15: a line sung often ends up brighter
    // than one sung once), an unsung row stays dark
    for (let r = 0; r < built.rows.length; r++) {
      const sung = sungSoFar[r];
      const aim = r === current ? 1 : sung > 0 ? Math.min(0.92, 0.42 + 0.1 * sung) : 0;
      this.lit[r] = still ? aim : easeTowards(this.lit[r], aim, f.dt, r === current ? 0.08 : 0.25);
    }

    // the rows' measure: they fill the height when they fit, and a window follows the singing
    // when they do not
    const n = built.rows.length;
    const bodyPx = typePx(f, "body") * (f.mini ? 0.9 : 1.05);
    const minPitch = Math.max(9, typePx(f, "small") * 1.25);
    const room = h * 0.86;
    let pitch = Math.min(bodyPx * 1.6, room / n);
    let visible = n;
    if (pitch < minPitch) {
      pitch = minPitch;
      visible = Math.max(1, Math.floor(room / pitch));
    }
    const px = clamp(pitch * 0.62, 8, bodyPx);
    if (visible < n) {
      const want = clamp(current - visible / 2, 0, n - visible);
      this.top = still ? want : easeTowards(this.top, want, f.dt, 0.3);
    } else this.top = 0;
    const y0 = h * 0.5 - ((Math.min(visible, n) - 1) * pitch) / 2;
    const yOf = (r: number): number => y0 + (r - this.top) * pitch;
    const left = w * (f.mini ? 0.12 : 0.17);
    const maxText = w - left - w * 0.06;

    // THE PATH, down the left: a step for the next row, an arc for a return
    const showPath = this.settings.path !== false && !f.mini;
    if (showPath && path.length > 1) {
      const x = left - Math.max(12, w * 0.03);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let k = 1; k < path.length; k++) {
        const a = path[k - 1];
        const b = path[k];
        if (a === b) continue;
        const ya = yOf(a);
        const yb = yOf(b);
        if (Math.max(ya, yb) < -pitch || Math.min(ya, yb) > h + pitch) continue;
        const last = k === path.length - 1;
        const strength = (last ? 0.35 + 0.55 * arrive : 0.3) * fadeOf(k);
        ctx.strokeStyle = rgba(P.gold, strength);
        ctx.lineWidth = last ? Math.max(1.5, h * 0.0025) : Math.max(1, h * 0.0015);
        ctx.beginPath();
        ctx.moveTo(x, ya);
        if (b === a + 1) ctx.lineTo(x, yb);
        else {
          // a return reaches back with an arc, wider the further it goes
          const reach = Math.min(x * 0.85, Math.max(14, Math.abs(b - a) * pitch * 0.28));
          ctx.bezierCurveTo(x - reach, ya, x - reach, yb, x, yb);
        }
        ctx.stroke();
      }
      // the head of the path: a dot on the row being sung
      if (current >= 0) {
        const y = yOf(current);
        ctx.fillStyle = rgba(P.gold, 0.9 * fadeOf(path.length - 1));
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2.5, h * 0.004) * (0.7 + 0.3 * arrive), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // THE ROWS
    ctx.textAlign = "start";
    const showMarks = this.settings.marks !== false && !f.mini;
    for (let r = 0; r < n; r++) {
      const y = yOf(r);
      if (y < -pitch || y > h + pitch) continue;
      const lit = this.lit[r];
      const isHook = r === built.hook;
      const isCurrent = r === current;
      const size = px * (isHook ? 1.3 : 1) * (isCurrent && !still ? 1 + 0.03 * this.punch : 1);
      setFont(ctx, isHook || isCurrent ? 600 : 500, size, f.font);
      const alpha = 0.28 + 0.62 * lit;
      ctx.fillStyle = isHook ? rgba(P.gold, 0.55 + 0.45 * lit) : rgba(P.ink, alpha);
      const text = ellipsize(ctx, built.rows[r].text, maxText);
      const slide = isCurrent && !still ? (1 - arrive) * pitch * 0.15 : 0;
      ctx.fillText(text, left, y + slide);
      // the marks: a dot per time sung so far, after the words
      if (showMarks && sungSoFar[r] > 1) {
        const tw = ctx.measureText(text).width;
        const d = Math.max(2, h * 0.003);
        const gap = d * 3;
        let mx = left + tw + gap * 2;
        const dots = Math.min(sungSoFar[r], 12);
        for (let i = 0; i < dots && mx < w - w * 0.03; i++) {
          ctx.fillStyle = rgba(isHook ? P.gold : P.dim, isCurrent && i === dots - 1 ? 0.95 : 0.6);
          ctx.beginPath();
          ctx.arc(mx, y, d, 0, Math.PI * 2);
          ctx.fill();
          mx += gap;
        }
      }
    }

    // a first line's arrival with nothing sung yet still gives the row its step
    if (path.length === 1 && showPath && current >= 0 && arrive < 1) {
      const x = left - Math.max(12, w * 0.03);
      ctx.strokeStyle = rgba(P.gold, 0.5 * arrive);
      ctx.lineWidth = Math.max(1, h * 0.0015);
      ctx.beginPath();
      ctx.moveTo(x, yOf(current) - pitch * STEP);
      ctx.lineTo(x, yOf(current));
      ctx.stroke();
    }
  }
}
