// THE WAVEFORM'S DRAWING on a canvas, every face's. Moved out of Waveform.tsx as it was (0.15.0, the
// hygiene pass); the analysis it draws is waveformAnalysis.ts's.
import { type Analysis } from "./waveformAnalysis";

/** Fold the 1200-bucket capture to a surface's own density. Peak folds by
 *  max; RMS folds in the power domain (root of the mean of squares), so a
 *  coarse view never overstates or understates loudness. */
function downsample(a: Analysis, n: number): { peak: Float32Array; rms: Float32Array } {
  const len = a.peak.length;
  if (n >= len) return { peak: a.peak, rms: a.rms };
  const peak = new Float32Array(n);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * len) / n);
    const end = Math.max(start + 1, Math.floor(((i + 1) * len) / n));
    let max = 0;
    let sumSq = 0;
    for (let k = start; k < end; k++) {
      if (a.peak[k] > max) max = a.peak[k];
      sumSq += a.rms[k] * a.rms[k];
    }
    peak[i] = max;
    rms[i] = Math.sqrt(sumSq / (end - start));
  }
  return { peak, rms };
}

interface DrawOpts {
  /** Strip alphas (played/unplayed split, no playhead line) vs panel alphas. */
  strip: boolean;
  /** Bars at a fixed pitch, or the continuous filled envelope (fullscreen). */
  style: "bars" | "envelope";
  /** Bar pitch in CSS px — the ~1.5px look every bar surface shares. */
  pitch?: number;
}

export function draw(
  canvas: HTMLCanvasElement,
  a: Analysis,
  progress: number | null,
  opts: DrawOpts,
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx || w <= 0) return;
  ctx.scale(dpr, dpr);
  const styles = getComputedStyle(document.documentElement);
  // The theme speaks in --gold-rgb (a space-separated triple); a bare
  // --gold does not exist, and the old fallback quietly painted every
  // theme the same hex (caught via the badge, 2026-08-31).
  const goldRgb = styles.getPropertyValue("--gold-rgb").trim() || "240 168 72";
  const gold = `rgb(${goldRgb})`;
  ctx.fillStyle = gold;
  const mid = h / 2;

  if (opts.style === "envelope") {
    // Continuous filled silhouettes at ~2px steps — the wide-canvas answer:
    // no slabs, just the mountain. Played/unplayed split via clip regions.
    const d = downsample(a, Math.max(2, Math.min(a.peak.length, Math.floor(w / 2))));
    const trace = (values: Float32Array): void => {
      const step = w / (values.length - 1);
      ctx.beginPath();
      ctx.moveTo(0, mid - values[0] * mid);
      for (let i = 1; i < values.length; i++) ctx.lineTo(i * step, mid - values[i] * mid);
      for (let i = values.length - 1; i >= 0; i--) ctx.lineTo(i * step, mid + values[i] * mid);
      ctx.closePath();
      ctx.fill();
    };
    const region = (x0: number, x1: number, peakAlpha: number, rmsAlpha: number): void => {
      if (x1 <= x0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, h);
      ctx.clip();
      ctx.globalAlpha = peakAlpha;
      trace(d.peak);
      ctx.globalAlpha = rmsAlpha;
      trace(d.rms);
      ctx.restore();
    };
    const split = progress != null ? progress * w : 0;
    region(0, split, 0.4, 1);
    region(split, w, 0.16, 0.4);
    return;
  }

  const d = downsample(
    a,
    Math.max(60, Math.min(a.peak.length, Math.round(w / (opts.pitch ?? 1.5)))),
  );
  const barW = w / d.peak.length;
  for (let i = 0; i < d.peak.length; i++) {
    const played = progress != null && i / d.peak.length <= progress;
    const x = i * barW;
    const bw = Math.max(0.5, barW - 0.75);
    // Peak envelope: the pale outline of what the track could do.
    ctx.globalAlpha = opts.strip ? (played ? 0.4 : 0.16) : played ? 0.5 : 0.24;
    const ph = Math.max(0.5, d.peak[i] * mid);
    ctx.fillRect(x, mid - ph, bw, ph * 2);
    // RMS envelope: the solid gold of what it actually does.
    ctx.globalAlpha = opts.strip ? (played ? 1 : 0.4) : played ? 1 : 0.55;
    const rh = Math.max(0.5, d.rms[i] * mid);
    ctx.fillRect(x, mid - rh, bw, rh * 2);
  }
  if (progress != null && !opts.strip) {
    ctx.globalAlpha = 0.9;
    ctx.fillRect(progress * w - 0.5, 0, 1, h);
  }
}
