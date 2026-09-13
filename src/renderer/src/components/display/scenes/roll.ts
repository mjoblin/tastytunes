import type {
  Rgb,
  Scene,
  SceneFrame,
  SceneKey,
  SceneRecord,
  SceneSettingDef,
  SceneSettings,
} from "./types";
import { easeTowards } from "../clock";
import { sceneFont } from "../type";
import { clamp, fitText, mix, rgb, rgba } from "./lib";
import { driftRecord } from "./survey/model";

/**
 * ROLL, shown as PIANO ROLL (renamed 2026-09-08; the id and the file keep the old name so
 * saved settings still resolve).
 *
 * THE ROLL. The whole track as a punched roll, a page you can read at a glance:
 * rows of time stacked down the frame, each row a stretch of the song, six lanes
 * of light in every row (bass at the bottom, air at the top) whose cells burn as
 * bright as that register at that moment. A head reads along the current row;
 * behind it the past is dimmed, ahead of it the rest of the song waits, all of
 * it in view. The beat ticks the row ahead, the drums spark off the head (kicks
 * from the low lanes, hats from the high), a chorus warms its stretch, a drop
 * bursts the row. The words sit under the row being read. It fills the frame
 * by construction (the Field it replaces was a road, and a road converges).
 * The roll itself is drawn once into an offscreen page and blitted; only the
 * head, the dimming, the sparks and the words are drawn each frame.
 */
export const ROLL_KEY: SceneKey = {
  reads: [
    {
      shows: "The page",
      means: "The whole track in rows of time, read left to right and top to bottom",
    },
    {
      shows: "Six lanes in each row",
      means: "Bass at the bottom to highs at the top. A cell's brightness is that band's level",
    },
    {
      shows: "The head",
      means: "Your position, moving along the row. The beats are marked on the row ahead",
    },
    { shows: "Behind the head", means: "The part already played, dimmed" },
    {
      shows: "Sparks off the head",
      means: "Drum hits. Kicks spark from the low lanes and hi-hats from the high ones",
    },
    { shows: "A warmer stretch", means: "A chorus" },
    { shows: "A burst of sparks", means: "A drop" },
    { shows: "The lyrics under the row", means: "The line being sung" },
  ],
  honesty: [
    "A cell is a tenth of a second, so a single hit shows as one bright cell rather than a spike.",
  ],
};

export const ROLL_SETTINGS: SceneSettingDef[] = [
  { key: "sparks", label: "Sparks", kind: "toggle", default: true, full: true },
  { key: "words", label: "Lyrics", kind: "toggle", default: true, full: true },
];

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  hue: Rgb;
}

interface Page {
  key: string;
  canvas: HTMLCanvasElement;
  rowSecs: number;
  rows: number;
  top: number;
  pitch: number;
  rowH: number;
  left: number;
  width: number;
  seconds: number;
}

const SPARKS_MAX = 240;
const HIT_THRESHOLD = 0.45;
const HIT_REFRACTORY_MS = 200;

export class Roll implements Scene {
  settings: SceneSettings = {};
  private drift = driftRecord();
  private page: Page | null = null;
  private sparks: Spark[] = [];
  private lastHit = 0;
  private flash = 0;
  private pulse = 0;
  private lastLine = -1;
  private lineSince = 0;

  /** Which register a lane wears: the art's accents across the six, the bass warmed toward gold. */
  private laneHue(P: SceneFrame["palette"], band: number): Rgb {
    const lane = (band + 0.5) / 6;
    const base =
      lane < 0.5
        ? mix(P.accent[0], P.accent[1], lane * 2)
        : mix(P.accent[1], P.accent[2], (lane - 0.5) * 2);
    return mix(base, P.gold, 0.25 * (1 - lane));
  }

  /** The page: rows and cells drawn once for a track at a size, redrawn only when one changes. */
  private ensurePage(f: SceneFrame, record: SceneRecord, seconds: number, dpr: number): Page {
    const { w, h, palette: P } = f;
    const sectionsKey = f.sections.map((s) => `${s.start.toFixed(1)}${s.kind[0]}`).join(",");
    const key = `${record.frames}|${seconds.toFixed(1)}|${w}x${h}@${dpr}|${P.light ? "l" : "d"}|${P.gold.join(".")}|${P.accent.map((a) => a.join(".")).join("/")}|${sectionsKey}|${f.mini ? "m" : ""}`;
    if (this.page && this.page.key === key) return this.page;
    // rows of time: about a dozen for a long track, never shorter than ten seconds each
    const rowSecs = Math.max(10, Math.ceil(seconds / 12 / 5) * 5);
    const rows = Math.max(1, Math.ceil(seconds / rowSecs));
    const top = h * (f.mini ? 0.08 : 0.06);
    const bottom = h * (f.mini ? 0.92 : 0.88);
    const pitch = (bottom - top) / rows;
    const rowH = pitch * (f.mini ? 0.82 : 0.72);
    const left = Math.round(w * 0.045);
    const width = w - 2 * left;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext("2d");
    if (g) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const laneH = rowH / 6;
      const pxPerSec = width / rowSecs;
      // a cell is the strip's frame, a tenth of a second, never thinner than two pixels
      const cellSecs = Math.max(1 / record.fps, 2 / pxPerSec);
      const cellW = cellSecs * pxPerSec;
      const hues = Array.from({ length: 6 }, (_, b) => this.laneHue(P, b));
      for (let r = 0; r < rows; r++) {
        const rowStart = r * rowSecs;
        const y0 = top + r * pitch;
        // the row's ground, and the chorus stretches warmed over it
        g.fillStyle = rgba(P.ink, P.light ? 0.035 : 0.03);
        g.fillRect(left, y0, width, rowH);
        for (const sec of f.sections) {
          if (sec.kind !== "chorus") continue;
          const a = Math.max(rowStart, sec.start);
          const b = Math.min(rowStart + rowSecs, sec.end);
          if (b <= a) continue;
          g.fillStyle = rgba(P.gold, 0.05 + 0.04 * sec.energy);
          g.fillRect(left + (a - rowStart) * pxPerSec, y0, (b - a) * pxPerSec, rowH);
        }
        // the cells: six lanes, bass at the bottom
        for (let t = rowStart; t < Math.min(seconds, rowStart + rowSecs); t += cellSecs) {
          const fa = Math.floor(t * record.fps);
          const fb = Math.max(fa + 1, Math.floor((t + cellSecs) * record.fps));
          const x = left + (t - rowStart) * pxPerSec;
          for (let band = 0; band < 6; band++) {
            let s = 0;
            let n = 0;
            for (let i = fa; i < fb && i < record.frames; i++) {
              s += record.bands[i * 6 + band];
              n++;
            }
            const level = n ? s / n : 0;
            if (level < 0.04) continue;
            const ly = y0 + (5 - band) * laneH;
            const ch = laneH * (0.4 + 0.45 * level);
            g.fillStyle = P.light
              ? rgba(mix(hues[band], P.ink, 0.5), 0.15 + 0.7 * level)
              : rgba(hues[band], 0.12 + 0.88 * level);
            g.fillRect(x, ly + (laneH - ch) / 2, Math.max(1, cellW - 0.6), ch);
          }
        }
      }
    }
    this.page = { key, canvas, rowSecs, rows, top, pitch, rowH, left, width, seconds };
    return this.page;
  }

  draw(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    const { w, h, palette: P } = f;
    const record = f.record ?? this.drift;
    const seconds = f.record ? (f.duration ?? record.frames / record.fps) : (f.duration ?? 240);
    const dpr = ctx.getTransform().a || 1;
    const page = this.ensurePage(f, record, seconds, dpr);
    const { rowSecs, rows, top, pitch, rowH, left, width } = page;
    const pxPerSec = width / rowSecs;
    const pos = clamp(f.position, 0, seconds);
    const row = Math.min(rows - 1, Math.floor(pos / rowSecs));
    const rowY = top + row * pitch;
    const headX = left + (pos - row * rowSecs) * pxPerSec;

    // the drums and the beat, eased; a drop bursts the row
    const sparksOn = this.settings.sparks !== false && !f.reduced && !f.mini;
    const hues = Array.from({ length: 6 }, (_, b) => this.laneHue(P, b));
    const laneH = rowH / 6;
    const throwSparks = (
      n: number,
      lanes: [number, number],
      vx: number,
      vy: number,
      up: number,
    ): void => {
      if (!sparksOn) return;
      for (let i = 0; i < n; i++) {
        const band = lanes[0] + Math.floor(Math.random() * (lanes[1] - lanes[0] + 1));
        const y = rowY + (5 - band + Math.random()) * laneH;
        this.sparks.push({
          x: headX + (Math.random() - 0.5) * 4,
          y,
          vx: (Math.random() - 0.5) * 2 * vx,
          vy: -up * (0.4 + Math.random()) + (Math.random() - 0.5) * vy,
          age: 0,
          life: 0.45 + Math.random() * 0.5,
          hue: hues[band],
        });
      }
      if (this.sparks.length > SPARKS_MAX) this.sparks.splice(0, this.sparks.length - SPARKS_MAX);
    };
    if (f.hitsKnown) {
      for (const hit of f.hits) {
        if (hit.type === "kick") throwSparks(5 + Math.round(9 * hit.strength), [0, 1], 90, 80, -60);
        else if (hit.type === "snare")
          throwSparks(4 + Math.round(8 * hit.strength), [2, 3], 220, 40, 30);
        else throwSparks(2 + Math.round(4 * hit.strength), [4, 5], 60, 30, 110);
      }
    } else {
      const hit = Math.max(f.onset, f.kick);
      if (hit > HIT_THRESHOLD && f.now - this.lastHit > HIT_REFRACTORY_MS) {
        this.lastHit = f.now;
        throwSparks(6 + Math.round(8 * hit), [0, 5], 120, 60, 40);
      }
    }
    if (f.beat?.onBeat) this.pulse = Math.max(this.pulse, f.beat.onBar ? 1 : 0.55);
    if (f.drop?.onDrop) {
      this.flash = 1;
      throwSparks(48, [0, 5], 260, 120, 80);
    }
    this.pulse = easeTowards(this.pulse, 0, f.dt, 0.14);
    this.flash = easeTowards(this.flash, 0, f.dt, 0.5);

    // THE PAGE, then the past dimmed: every row above this one, and this row up to the head
    ctx.fillStyle = rgb(P.bg);
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(page.canvas, 0, 0, w, h);
    const dim = rgba(P.bg, P.light ? 0.5 : 0.58);
    ctx.fillStyle = dim;
    if (row > 0) ctx.fillRect(left - 2, top - 2, width + 4, row * pitch);
    ctx.fillRect(left - 2, rowY - 2, Math.max(0, headX - left + 2), rowH + 4);

    // the row being read, lit a little (more in a drop's flash); the beat ticked along it ahead
    ctx.fillStyle = rgba(P.gold, 0.05 + 0.3 * this.flash);
    ctx.fillRect(left, rowY, width, rowH);
    if (f.beat && f.beat.confidence >= 0.35 && !f.mini) {
      const period = 60 / f.beat.bpm;
      const bar = f.beat.onBar ? 0 : Math.round(f.beat.bar * 4) % 4;
      let t = pos - f.beat.phase * period;
      let k = 0;
      const rowEnd = Math.min(seconds, (row + 1) * rowSecs);
      while (t < rowEnd && k < 400) {
        if (t >= pos) {
          const heavy = (k - bar) % 4 === 0;
          ctx.fillStyle = rgba(P.gold, heavy ? 0.4 : 0.16);
          const x = left + (t - row * rowSecs) * pxPerSec;
          ctx.fillRect(x, rowY - 3, 1, heavy ? 3 : 2);
        }
        t += period;
        k++;
      }
    }

    // THE HEAD: a line of light across the row, pulsing with the beat, flaring in a drop
    const headW = 2 + 1.5 * this.pulse + 3 * this.flash;
    if (!P.light) {
      ctx.shadowColor = rgba(P.gold, 0.8);
      ctx.shadowBlur = 10 + 14 * this.pulse + 30 * this.flash;
    }
    ctx.fillStyle = rgba(mix(P.gold, P.light ? P.ink : [255, 255, 255], 0.35), 0.95);
    ctx.fillRect(headX - headW / 2, rowY - 4, headW, rowH + 8);
    ctx.shadowBlur = 0;
    const halo = ctx.createLinearGradient(headX - 36, 0, headX + 36, 0);
    halo.addColorStop(0, rgba(P.gold, 0));
    halo.addColorStop(0.5, rgba(P.gold, 0.14 + 0.25 * this.flash));
    halo.addColorStop(1, rgba(P.gold, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(headX - 36, rowY, 72, rowH);

    // THE SPARKS: thrown off the head, falling or rising with their lane, gone within a second
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += f.dt;
      if (s.age > s.life) {
        this.sparks.splice(i, 1);
        continue;
      }
      s.vy += 160 * f.dt;
      s.x += s.vx * f.dt;
      s.y += s.vy * f.dt;
      const k = 1 - s.age / s.life;
      ctx.fillStyle = rgba(mix(s.hue, P.gold, 0.4), 0.9 * k);
      ctx.fillRect(s.x - 1, s.y - 1, 2 + 1.5 * k, 2 + 1.5 * k);
    }

    // THE WORDS: the current line under the row being read (above it on the last row), starting
    // at the head and kept inside the margins, on a soft backing so the cells never fight it
    if (f.lyric?.text && this.settings.words !== false) {
      if (f.lyric.index !== this.lastLine) {
        this.lastLine = f.lyric.index;
        this.lineSince = f.now;
      }
      const arrive = f.reduced ? 1 : clamp((f.now - this.lineSince) / 300);
      const px0 = sceneFont(ctx, f, "body", 500);
      const fit = fitText(ctx, f.lyric.text, {
        maxWidth: width * 0.6,
        maxPx: px0,
        minPx: px0 * 0.7,
        maxLines: 2,
        weight: 500,
        family: f.font,
      });
      sceneFont(ctx, f, fit.px, 500);
      const lineH = fit.px * 1.2;
      const blockH = lineH * fit.lines.length;
      const below = rowY + rowH + 6 + blockH < h * 0.9;
      // the words follow the head and settle against the right margin with a BRIEF slowdown:
      // half a second of head travel, the block's speed falling in a straight line to zero over
      // the quarter second before it would touch the margin and the quarter after, so it comes
      // to rest exactly there (the user: "no more than half a second")
      const limit = left + width - fit.width - 8;
      const raw = headX + 8;
      const zone = pxPerSec * 0.25;
      const over = raw - (limit - zone);
      const x = Math.max(
        left,
        over <= 0
          ? raw
          : over >= 2 * zone
            ? limit
            : limit - zone + over - (over * over) / (4 * zone),
      );
      const y0 = below ? rowY + rowH + 6 + fit.px : rowY - 8 - blockH + fit.px;
      ctx.fillStyle = rgba(P.bg, 0.72 * arrive);
      ctx.beginPath();
      ctx.roundRect(x - 6, y0 - fit.px - 2, fit.width + 12, blockH + 6, 5);
      ctx.fill();
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = rgba(mix(P.ink, P.gold, 0.6), arrive);
      fit.lines.forEach((l, k) => ctx.fillText(l, x, y0 + k * lineH));
    }
  }
}
