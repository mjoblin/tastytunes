import type { Rgb, Scene, SceneFrame, SceneKey, SceneSettingDef, SceneSettings } from "./types";
import { easeTowards } from "../clock";
import { monoFont } from "../type";
import { BAND_EDGES_HZ } from "@/lib/featureStrip";
import { clamp, mix, rgb, rgba } from "./lib";

/**
 * FRONT PANEL. The glowing display of a hi-fi deck, a vacuum fluorescent panel behind
 * smoked glass: the lyric being sung in dot-matrix across the middle, the title and the
 * artist beneath it, the track number and the time in seven segments, the source and the
 * transport's modes as lamps along the top, and a six-band analyzer. Every element that
 * is off still shows faintly, as the unlit segments of a real panel do; what is lit is
 * what the streamer reports (the source, the track, the time, repeat and shuffle), so the
 * scene draws for any source, a station and a cast included, and never makes a reading
 * up: the analyzer lights only for a track with an analysis, and the position row only
 * for a track with a length. The lyric wraps onto two rows as a two-line panel shows a
 * message; a line longer than two rows pages within its own time, since a line is timed as a
 * whole, never by the word. The line beneath scrolls as a marquee when it is long.
 */
export const PANEL_KEY: SceneKey = {
  reads: [
    {
      shows: "The large line",
      means: "The lyric being sung. Without lyrics, the title, or the station's current track.",
    },
    { shows: "The line beneath", means: "The title and artist, or the artist and album." },
    { shows: "The digits", means: "The track's place in the queue and the time into it." },
    { shows: "The lamps along the top", means: "The source, and whether shuffle or repeat is on." },
    {
      shows: "The bars",
      means: "Six frequency bands, bass on the left. Lit only for an analyzed track.",
    },
    { shows: "The dotted row", means: "Track position." },
  ],
  honesty: [
    "Lyrics are timed by the line, so a long line turns its page halfway, not word by word.",
  ],
};

export const PANEL_SETTINGS: SceneSettingDef[] = [
  {
    key: "glow",
    label: "Glow",
    kind: "select",
    options: [
      { value: "teal", label: "Teal" },
      { value: "amber", label: "Amber" },
      { value: "art", label: "Album art" },
    ],
    default: "teal",
  },
];

/** A vacuum fluorescent display's own blue-green, and the amber of a gas-discharge panel. */
const TEAL: Rgb = [110, 246, 214];
const AMBER: Rgb = [255, 184, 76];
/** How bright an unlit element shows through the glass: a segment or a lamp, and a dot of
 *  a matrix, whose grid would read as a grey slab at a segment's level. */
const GHOST = 0.075;
const GHOST_DOT = 0.03;
/** The weight the dots are drawn from: a stroke a dot or two wide, as a panel's font is. */
const DOT_WEIGHT = 560;
/** A title marquee's pace, in columns a second. */
const MARQUEE_COLS = 7;

/** Text rasterized to a grid of dots: `cols` wide, `rows` high, one byte a dot. */
interface Dots {
  cols: number;
  rows: number;
  bits: Uint8Array;
}

let sansStack: string | null = null;
/** The app's UI sans, read once off :root: the dots are drawn from its outlines. */
function sansFont(): string {
  if (sansStack == null) {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim();
    sansStack = v || "ui-sans-serif, system-ui, sans-serif";
  }
  return sansStack;
}

const dotCache = new Map<string, Dots>();
/** A line of text as dots `rows` high: drawn small with the UI sans and thresholded, so any
 *  script the font has (accents, Cyrillic, Japanese) shows, not only a bitmap font's ASCII. */
function rasterize(text: string, rows: number, weight = DOT_WEIGHT): Dots {
  const key = `${rows}|${weight}|${text}`;
  const hit = dotCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  const g = c.getContext("2d", { willReadFrequently: true });
  const empty: Dots = { cols: 0, rows, bits: new Uint8Array(0) };
  if (!g || !text) return empty;
  const px = rows * 0.98;
  const font = `${weight} ${px}px ${sansFont()}`;
  g.font = font;
  const cols = Math.max(1, Math.ceil(g.measureText(text).width) + 1);
  c.width = cols;
  c.height = rows;
  g.font = font;
  g.fillStyle = "#fff";
  g.textBaseline = "alphabetic";
  g.fillText(text, 0, Math.round(rows * 0.8));
  const data = g.getImageData(0, 0, cols, rows).data;
  const bits = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) bits[i] = data[i * 4 + 3] > 96 ? 1 : 0;
  const dots: Dots = { cols, rows, bits };
  dotCache.set(key, dots);
  if (dotCache.size > 160) dotCache.delete(dotCache.keys().next().value as string);
  return dots;
}

let measurer: CanvasRenderingContext2D | null = null;
/** Width in dots of `text` rasterized `rows` high (rasterize's own font and size). */
function dotWidth(text: string, rows: number): number {
  measurer ??= document.createElement("canvas").getContext("2d");
  if (!measurer) return text.length * rows * 0.6;
  measurer.font = `${DOT_WEIGHT} ${rows * 0.98}px ${sansFont()}`;
  return Math.ceil(measurer.measureText(text).width) + 1;
}

/** Word-wrap to `cols` dots; a word wider than the glass is cut at the edge. */
function wrapDots(text: string, rows: number, cols: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const wd of words) {
    const probe = line ? `${line} ${wd}` : wd;
    if (line && dotWidth(probe, rows) > cols) {
      lines.push(line);
      line = wd;
    } else line = probe;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Seven-segment outlines for a digit cell of width w and height h at (x, y): a..g in the
 * usual order, each a slanted hexagon. `null` in the pattern means a blank cell.
 */
const SEGMENTS: Record<string, number> = {
  "0": 0b1111110,
  "1": 0b0110000,
  "2": 0b1101101,
  "3": 0b1111001,
  "4": 0b0110011,
  "5": 0b1011011,
  "6": 0b1011111,
  "7": 0b1110000,
  "8": 0b1111111,
  "9": 0b1111011,
  "-": 0b0000001,
  " ": 0,
};

function segmentPath(x: number, y: number, w: number, h: number, seg: number): Path2D {
  const t = Math.max(1.5, w * 0.17);
  const slant = w * 0.12;
  const mid = y + h / 2;
  // x shifts right as y rises: the italic of a real panel's digits
  const sx = (py: number): number => ((y + h - py) / h) * slant;
  const p = new Path2D();
  const horiz = (py: number): void => {
    const x0 = x + t * 0.55;
    const x1 = x + w - t * 0.55;
    p.moveTo(x0 + sx(py), py);
    p.lineTo(x0 + t / 2 + sx(py - t / 2), py - t / 2);
    p.lineTo(x1 - t / 2 + sx(py - t / 2), py - t / 2);
    p.lineTo(x1 + sx(py), py);
    p.lineTo(x1 - t / 2 + sx(py + t / 2), py + t / 2);
    p.lineTo(x0 + t / 2 + sx(py + t / 2), py + t / 2);
    p.closePath();
  };
  const vert = (px: number, y0: number, y1: number): void => {
    const a = y0 + t * 0.55;
    const b = y1 - t * 0.55;
    p.moveTo(px + sx(a), a);
    p.lineTo(px + t / 2 + sx(a + t / 2), a + t / 2);
    p.lineTo(px + t / 2 + sx(b - t / 2), b - t / 2);
    p.lineTo(px + sx(b), b);
    p.lineTo(px - t / 2 + sx(b - t / 2), b - t / 2);
    p.lineTo(px - t / 2 + sx(a + t / 2), a + t / 2);
    p.closePath();
  };
  switch (seg) {
    case 0:
      horiz(y + t / 2);
      break;
    case 1:
      vert(x + w - t / 2, y, mid);
      break;
    case 2:
      vert(x + w - t / 2, mid, y + h);
      break;
    case 3:
      horiz(y + h - t / 2);
      break;
    case 4:
      vert(x + t / 2, mid, y + h);
      break;
    case 5:
      vert(x + t / 2, y, mid);
      break;
    default:
      horiz(mid);
  }
  return p;
}

const fmtTime = (secs: number): string => {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  return `${m > 99 ? 99 : m}:${String(s % 60).padStart(2, "0")}`;
};

/** The analyzer's two ends, printed under it: the lowest and the highest band's center
 *  frequency (the geometric mean of its edges). */
const bandCenter = (i: number): number => Math.sqrt(BAND_EDGES_HZ[i] * BAND_EDGES_HZ[i + 1]);
const hzLabel = (hz: number): string =>
  hz >= 1000 ? `${Math.round(hz / 1000)} kHz` : `${Math.round(hz / 10) * 10} Hz`;
const BAND_LOW = hzLabel(bandCenter(0));
const BAND_HIGH = hzLabel(bandCenter(BAND_EDGES_HZ.length - 2));

export class Panel implements Scene {
  settings: SceneSettings = {};
  /** What the large line shows, and when it began: the title marquee keeps its own clock. */
  private mainText = "";
  private mainSince = 0;
  private bars = new Float32Array(6);
  private peaks = new Float32Array(6);

  private color(f: SceneFrame): Rgb {
    const g = this.settings.glow;
    if (g === "amber") return AMBER;
    if (g === "art") return mix(f.palette.accent[0], [255, 255, 255], 0.35);
    return TEAL;
  }

  draw(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    const { w, h, palette: P, deck } = f;
    const lit = this.color(f);
    // the faceplate around the glass: the theme's own ground, so the panel is a device
    // sitting on the page in either theme; the glass itself is always dark
    ctx.fillStyle = rgb(P.bg);
    ctx.fillRect(0, 0, w, h);

    const mini = f.mini || w < 520;
    const gw = mini ? w * 0.92 : Math.min(w * 0.86, h * 2.6);
    // the tile is square, so its glass is nearly square too: room for three lines and the time
    const gh = mini ? Math.min(h * 0.82, gw * 0.9) : Math.min(h * 0.62, gw * 0.4);
    const gx = (w - gw) / 2;
    const gy = (h - gh) / 2;
    const r = Math.min(gw, gh) * 0.05;

    // the glass: near black with a cast of the lit color, a hairline bezel and a
    // reflection across its upper half
    const glass = new Path2D();
    glass.roundRect(gx, gy, gw, gh, r);
    ctx.fillStyle = `rgb(${Math.round(4 + lit[0] * 0.015)},${Math.round(6 + lit[1] * 0.015)},${Math.round(6 + lit[2] * 0.015)})`;
    ctx.fill(glass);
    ctx.save();
    ctx.clip(glass);

    const pad = gh * 0.08;
    const ix = gx + pad * 1.3;
    const iw = gw - pad * 2.6;

    // the lit elements are gathered into one path per brightness and filled once, the glow
    // a shadow on that one fill: a thousand dots cost one blur
    const on = new Path2D();
    const dim = new Path2D();
    const ghost = new Path2D();
    const ghostDots = new Path2D();

    // ---- the large line: two rows of dots, as a two-line panel; a line longer than two
    // rows pages within its own time (a lyric) or every few seconds (a title)
    const lyric = f.lyric;
    const sung = lyric && lyric.text ? lyric.text : "";
    const waiting = lyric && !lyric.text ? lyric.next : null;
    const fallback = deck.radio ? (f.subtitle ?? f.title ?? "") : (f.title ?? "");
    const text = waiting ?? (sung || fallback);
    if (text !== this.mainText) {
      this.mainText = text;
      this.mainSince = f.now;
    }
    const rows = mini ? 11 : 14;
    const pitch = iw / (mini ? 80 : 200);
    const cols = Math.floor(iw / pitch);
    const dot = pitch * 0.74;
    const lineGap = 3;
    // the wall shows two lines at a time; the tile, narrower, three
    const perPage = mini ? 3 : 2;
    const mainH = (rows * perPage + lineGap * (perPage - 1)) * pitch;
    const subRows = 11;
    const legendPx = Math.max(7, gh * (mini ? 0.05 : 0.04));
    const digitH = mini ? rows * pitch * 1.1 : subRows * pitch * 1.3;
    // the lines, then a row of the line beneath with the analyzer and the digits, centered
    // between the lamps and the position row
    const bandTop = gy + gh * (mini ? 0.17 : 0.2);
    const bandBottom = gy + gh * (mini ? 0.86 : 0.88);
    const aboveRow = mini ? pitch * 4 : legendPx * 2.4;
    const blockH = mainH + aboveRow + digitH + (mini ? 0 : legendPx * 1.8);
    const mainTop = bandTop + Math.max(0, (bandBottom - bandTop - blockH) / 2);
    const rowTop = mainTop + mainH + aboveRow;

    const wrapped = wrapDots(text, rows, cols - 2);
    const pages = Math.max(1, Math.ceil(wrapped.length / perPage));
    let page = 0;
    if (pages > 1)
      page =
        sung && lyric
          ? Math.min(pages - 1, Math.floor(lyric.progress * pages))
          : Math.floor((f.now - this.mainSince) / 4000) % pages;
    const shown = wrapped.slice(page * perPage, page * perPage + perPage);
    const mainPath = waiting ? dim : on;
    const mainLeft = ix + (iw - cols * pitch) / 2;
    for (let li = 0; li < perPage; li++) {
      const d = rasterize(shown[li] ?? "", rows);
      // a line sits centered, as a panel centers a message
      const lead = Math.floor((cols - d.cols) / 2);
      const top = mainTop + li * (rows + lineGap) * pitch;
      for (let c = 0; c < cols; c++) {
        const src = c - lead;
        for (let y = 0; y < rows; y++) {
          const litDot = src >= 0 && src < d.cols && d.bits[y * d.cols + src] === 1;
          (litDot ? mainPath : ghostDots).rect(mainLeft + c * pitch, top + y * pitch, dot, dot);
        }
      }
    }

    // ---- the line beneath: the title and artist under a lyric, else the artist and album,
    // a marquee when it is longer than its window
    // the readouts take what their seven cells need (two for the track, five for the time)
    const cellW = digitH * 0.52 * 1.32;
    const readoutW = mini ? 0 : cellW * 7.4;
    const analyzerW = mini ? 0 : iw * 0.17;
    if (!mini) {
      const subParts = sung
        ? [f.title, f.subtitle]
        : deck.radio
          ? [f.title]
          : [f.subtitle, deck.album];
      const sub = subParts.filter(Boolean).join("  ·  ");
      const subLeft = ix + analyzerW + iw * 0.04;
      const subW = iw - analyzerW - readoutW - iw * 0.08;
      const subCols = Math.max(4, Math.floor(subW / pitch));
      const subTop = rowTop + (digitH - subRows * pitch) / 2;
      const subDots = rasterize(sub, subRows);
      const subOver = subDots.cols - subCols;
      let subOffset = 0;
      if (subOver > 0 && !f.reduced) {
        const travel = subOver / MARQUEE_COLS;
        const t = (f.now / 1000) % (travel + 5);
        subOffset = Math.round(subOver * clamp((t - 2.5) / travel));
      }
      // a short line sits at the window's left, where a panel's second line starts
      for (let c = 0; c < subCols; c++) {
        const src = c + subOffset;
        for (let y = 0; y < subRows; y++) {
          const litDot =
            src >= 0 && src < subDots.cols && subDots.bits[y * subDots.cols + src] === 1;
          (litDot ? on : ghostDots).rect(subLeft + c * pitch, subTop + y * pitch, dot, dot);
        }
      }
    }

    // ---- the seven-segment readouts: the track's place, and the time into it
    const digitW = digitH * 0.52;
    const gap = digitW * 0.32;
    const timeStr = deck.loaded ? fmtTime(f.position).padStart(5, " ") : "  :  ";
    const trackStr = deck.track ? String(Math.min(99, deck.track.index)).padStart(2, "0") : "--";
    const segs = (s: string, x: number, y: number, allLit: boolean): number => {
      let cx = x;
      for (const ch of s) {
        if (ch === ":") {
          const d = digitW * 0.18;
          (allLit ? on : ghost).rect(cx, y + digitH * 0.28, d, d);
          (allLit ? on : ghost).rect(cx, y + digitH * 0.66, d, d);
          cx += d + gap;
          continue;
        }
        const pat = SEGMENTS[ch] ?? 0;
        for (let sgi = 0; sgi < 7; sgi++) {
          const litSeg = allLit && ((pat >> (6 - sgi)) & 1) === 1;
          (litSeg ? on : ghost).addPath(segmentPath(cx, y, digitW, digitH, sgi));
        }
        cx += digitW + gap;
      }
      return cx;
    };
    const legends: { text: string; x: number; y: number; align?: CanvasTextAlign }[] = [];
    if (mini) {
      const timeW = timeStr.length * (digitW + gap);
      segs(timeStr, gx + (gw - timeW) / 2, rowTop, deck.loaded);
    } else {
      const tx = ix + iw - readoutW;
      const afterTrack = segs(trackStr, tx, rowTop, deck.track != null);
      legends.push({ text: "TRACK", x: tx, y: rowTop - legendPx * 0.7 });
      const timeX = afterTrack + gap * 1.5;
      segs(timeStr, timeX, rowTop, deck.loaded);
      legends.push({ text: deck.radio ? "TUNED" : "TIME", x: timeX, y: rowTop - legendPx * 0.7 });
    }

    // ---- the analyzer: six bars, lit only for an analyzed track, each falling back slowly
    // with a held peak above it, as a panel's meter does
    if (!mini) {
      const segsN = 11;
      const barGap = analyzerW * 0.06;
      const barW = (analyzerW - barGap * 5) / 6;
      const segH = digitH / segsN;
      for (let b = 0; b < 6; b++) {
        const level = f.real ? f.bands[b] : 0;
        this.bars[b] = easeTowards(this.bars[b], level, f.dt, level > this.bars[b] ? 0.04 : 0.22);
        this.peaks[b] =
          level >= this.peaks[b] ? level : Math.max(this.bars[b], this.peaks[b] - f.dt * 0.35);
        const n = Math.round(this.bars[b] * segsN);
        const peak = Math.min(segsN - 1, Math.round(this.peaks[b] * segsN));
        const bx = ix + b * (barW + barGap);
        for (let sgi = 0; sgi < segsN; sgi++) {
          const y = rowTop + digitH - (sgi + 1) * segH + segH * 0.18;
          const litSeg = f.real && (sgi < n || (sgi === peak && peak > 0));
          (litSeg ? on : ghost).rect(bx, y, barW, segH * 0.64);
        }
      }
      const legendY = rowTop + digitH + legendPx * 1.5;
      legends.push({ text: BAND_LOW, x: ix, y: legendY });
      legends.push({ text: BAND_HIGH, x: ix + analyzerW, y: legendY, align: "right" });
    }

    // ---- the lamps along the top: the source, and the transport's modes
    let lampPx = Math.max(7, gh * (mini ? 0.055 : 0.06));
    const lampY = mini ? gy + gh * 0.09 : gy + gh * 0.12;
    const lamps: { text: string; on: boolean }[] = [
      { text: (deck.source ?? "—").toUpperCase(), on: deck.loaded },
      { text: "LIVE", on: deck.radio },
      { text: "SHUFFLE", on: deck.shuffle },
      { text: "REPEAT", on: deck.repeat !== "off" },
      { text: "1", on: deck.repeat === "one" },
      { text: "▶", on: f.playing },
      { text: "❚❚", on: deck.loaded && !f.playing },
    ];
    ctx.textBaseline = "middle";
    const shownLamps = lamps.filter((l) => !mini || (l.text !== "LIVE" && l.text !== "1"));
    const spacing = mini ? 0.9 : 1.6;
    const lampRowW = (): number => {
      ctx.font = `600 ${lampPx}px ${monoFont()}`;
      return shownLamps.reduce(
        (sum, l) => sum + ctx.measureText(l.text).width + lampPx * spacing,
        0,
      );
    };
    // a long source name shrinks the row to the glass rather than running off it
    const rowW = lampRowW();
    if (rowW > iw) {
      lampPx *= iw / rowW;
      lampRowW();
    }
    let lx = ix;
    const lampSpan: { text: string; x: number; on: boolean }[] = [];
    for (const l of shownLamps) {
      lampSpan.push({ text: l.text, x: lx, on: l.on });
      lx += ctx.measureText(l.text).width + lampPx * spacing;
    }

    // ---- the position row along the bottom of the glass
    const rowY = mini ? gy + gh * 0.9 : gy + gh * 0.93;
    const rowDots = mini ? 40 : 96;
    const rowPitch = iw / rowDots;
    const share = f.duration && f.duration > 0 ? clamp(f.position / f.duration) : null;
    for (let i = 0; i < rowDots; i++) {
      const litDot = share != null && i / rowDots < share;
      (litDot ? dim : ghostDots).rect(ix + i * rowPitch, rowY, rowPitch * 0.5, rowPitch * 0.5);
    }

    // paint: the ghosts, then the dim and the full, each once with its glow
    ctx.fillStyle = rgba(lit, GHOST);
    ctx.fill(ghost);
    ctx.fillStyle = rgba(lit, GHOST_DOT);
    ctx.fill(ghostDots);
    ctx.shadowColor = rgba(lit, 0.85);
    ctx.shadowBlur = Math.max(2, pitch * 0.9);
    ctx.fillStyle = rgba(lit, 0.5);
    ctx.fill(dim);
    ctx.fillStyle = rgba(lit, 1);
    ctx.fill(on);
    for (const l of lampSpan) {
      ctx.fillStyle = rgba(lit, l.on ? 1 : GHOST);
      ctx.shadowBlur = l.on ? Math.max(2, lampPx * 0.6) : 0;
      ctx.fillText(l.text, l.x, lampY);
    }
    ctx.shadowBlur = 0;

    // the legends are printed on the glass, not lit: a pale silkscreen
    ctx.font = `500 ${legendPx}px ${monoFont()}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = rgba([220, 226, 224], 0.3);
    for (const l of legends) {
      ctx.textAlign = l.align ?? "left";
      ctx.fillText(l.text, l.x, l.y);
    }
    ctx.textAlign = "left";

    // the reflection, last: a soft diagonal sheen across the upper glass
    const sheen = ctx.createLinearGradient(gx, gy, gx + gw * 0.4, gy + gh);
    sheen.addColorStop(0, "rgba(255,255,255,0.05)");
    sheen.addColorStop(0.45, "rgba(255,255,255,0.015)");
    sheen.addColorStop(0.46, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(gx, gy, gw, gh);
    ctx.restore();

    // the bezel's hairline
    ctx.strokeStyle = rgba(P.light ? P.dim : P.faint, P.light ? 0.5 : 0.35);
    ctx.lineWidth = 1;
    ctx.stroke(glass);
  }
}
