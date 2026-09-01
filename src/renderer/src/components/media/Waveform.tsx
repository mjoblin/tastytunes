import { useEffect, useRef, useState } from "react";
import { tt } from "@/api";
import { useStore } from "@/store";
import { nowPlayingInfoTarget } from "@/lib/mediaInfo";
import { computeDr14 } from "@/lib/dr14";

/**
 * EXPERIMENT (0.7 exploration, the audio-file-data GO): waveforms from the
 * file's own bytes. Main fetches the audio from the LOCAL media server; this
 * module decodes with WebAudio and keeps TWO envelopes per track — peak and
 * RMS — so the drawing shows dynamics, not just shape: a crushed master
 * reads as a solid brick, an open one as gold hills inside a pale outline.
 * Everything is best-effort and silent on failure; analyses are cached (as
 * in-flight promises, so StrictMode's double effects share one fetch) for
 * the session.
 *
 * Two faces: the Stream tab's panel view (envelopes, playhead, click-to-
 * seek, a quiet stats row) and display mode's bottom strip, where the
 * waveform stands in for the progress bar when peaks exist. Honest labels
 * only: peak/RMS/crest are what this decode truly measures, and DR is the
 * real TT procedure (lib/dr14.ts, validated integer-exact against the
 * reference — a name that specific is a citation, so nothing less would
 * do). "LUFS" still waits for the R128 analysis pass.
 *
 * RESOLUTION IS A CAPTURE PROPERTY, BAR WIDTH A PER-SURFACE FIT: analysis
 * keeps 1200 buckets (~10KB/track) and every renderer downsamples to its
 * own density — bars hold a ~1.5px pitch wherever they draw, and the
 * fullscreen strip renders a continuous filled envelope instead of
 * stretching a fixed bucket count into 10px slabs (user, 2026-08-30, on
 * noticing exactly that).
 */

const CAPTURE_BUCKETS = 1200;

interface Analysis {
  peak: Float32Array;
  rms: Float32Array;
  peakDb: number;
  rmsDb: number;
  crestDb: number;
  /** TT dynamic range integer; <= 0 means "no honest number" and hides. */
  dr: number;
}

const cache = new Map<string, Promise<Analysis | null>>();

/**
 * Optimistic seek hold, shared by every waveform surface: between a click
 * and the device's playhead catching up, the streamer's position pushes
 * pass through transient values (a beat of zero included) — without the
 * hold, the played region snapped to nothing and popped back at the target
 * (seen live, 2026-08-30). The hold releases when the device lands near
 * the target, or after its window — the optimistic-hold family's shape.
 */
let seekHold: { pct: number; until: number } | null = null;
const SEEK_HOLD_MS = 2500;
function holdSeek(pct: number): void {
  seekHold = { pct, until: Date.now() + SEEK_HOLD_MS };
}

function analyze(serverUdn: string, objectId: string): Promise<Analysis | null> {
  const key = `${serverUdn}|${objectId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<Analysis | null> => {
    const bytes = await tt.expTrackAudio(serverUdn, objectId);
    if (!bytes) return null;
    const u8 = new Uint8Array(bytes);
    const ctx = new AudioContext();
    try {
      const audio = await ctx.decodeAudioData(u8.slice().buffer);
      const chans: Float32Array[] = [];
      for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
      const frames = chans[0].length;
      // The GLOBAL peak is a full scan of every sample on every channel —
      // stride sampling could miss the single hottest sample and understate
      // peak (and crest with it) by whole dB on percussive material. One
      // pass over the floats costs tens of milliseconds, once per track.
      // Still SAMPLE peak, honestly: true peak (dBTP, 4x oversampled) is
      // the R128 pass's job.
      let globalPeak = 0;
      for (const data of chans) {
        for (let i = 0; i < frames; i++) {
          const a = Math.abs(data[i]);
          if (a > globalPeak) globalPeak = a;
        }
      }
      // Bucket envelopes and global RMS read BOTH channels (power-combined),
      // strided within each bucket — RMS is statistically robust to the
      // stride; peak above is not, hence the split.
      const peak = new Float32Array(CAPTURE_BUCKETS);
      const rms = new Float32Array(CAPTURE_BUCKETS);
      const per = Math.max(1, Math.floor(frames / CAPTURE_BUCKETS));
      let globalSumSq = 0;
      let globalN = 0;
      for (let b = 0; b < CAPTURE_BUCKETS; b++) {
        const start = b * per;
        const end = Math.min(start + per, frames);
        const step = Math.max(1, Math.floor((end - start) / 200));
        let max = 0;
        let sumSq = 0;
        let n = 0;
        for (const data of chans) {
          for (let i = start; i < end; i += step) {
            const v = data[i];
            const a = Math.abs(v);
            if (a > max) max = a;
            sumSq += v * v;
            n++;
          }
        }
        peak[b] = max;
        rms[b] = n > 0 ? Math.sqrt(sumSq / n) : 0;
        globalSumSq += sumSq;
        globalN += n;
      }
      const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);
      const peakDb = db(globalPeak);
      const rmsDb = db(globalN > 0 ? Math.sqrt(globalSumSq / globalN) : 0);
      const dr = computeDr14(chans, audio.sampleRate);
      return { peak, rms, peakDb, rmsDb, crestDb: peakDb - rmsDb, dr };
    } catch {
      return null;
    } finally {
      void ctx.close();
    }
  })();
  cache.set(key, p);
  return p;
}

function usePeaks(serverUdn: string | null, objectId: string | null): Analysis | null | "loading" {
  const [state, setState] = useState<Analysis | null | "loading">("loading");
  useEffect(() => {
    if (!serverUdn || !objectId) {
      setState(null);
      return;
    }
    let stale = false;
    setState("loading");
    void analyze(serverUdn, objectId).then((a) => {
      if (!stale) setState(a);
    });
    return () => {
      stale = true;
    };
  }, [serverUdn, objectId]);
  return state;
}

/** The playing track's library identity, resolved by content — for surfaces
 *  (display mode) that don't already hold the Stream tab's enriched node. */
export function usePlayingFileRef(): { serverUdn: string; objectId: string } | null {
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const [ref, setRef] = useState<{ serverUdn: string; objectId: string } | null>(null);
  const md = playState?.metadata;
  const trackKey = `${md?.title ?? ""}|${md?.artist ?? ""}|${md?.album ?? ""}`;
  const psRef = useRef(playState);
  psRef.current = playState;
  const npRef = useRef(nowPlaying);
  npRef.current = nowPlaying;
  useEffect(() => {
    let stale = false;
    setRef(null);
    const built = nowPlayingInfoTarget(psRef.current, npRef.current);
    if (!built?.localQuery) return;
    void tt
      .mediaNodeInfo(built.localQuery)
      .then((found) => {
        if (stale || !found?.node.serverUdn || !found.node.id) return;
        setRef({ serverUdn: found.node.serverUdn, objectId: found.node.id });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [trackKey]);
  return ref;
}

/** Interpolated play progress 0..1, ticking gently; null without a duration. */
function useProgress(): number | null {
  const playhead = useStore((s) => s.playhead);
  const duration = useStore((s) => s.playState?.metadata?.duration ?? null);
  const playing = useStore((s) => s.playState?.state === "play");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  if (playhead == null || duration == null || duration <= 0) return null;
  const secs = playhead.secs + (playing ? (now - playhead.at) / 1000 : 0);
  const device = Math.max(0, Math.min(1, secs / duration));
  if (seekHold) {
    if (now > seekHold.until || Math.abs(device - seekHold.pct) < 0.02) seekHold = null;
    else return seekHold.pct;
  }
  return device;
}

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

function draw(
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
  const gold = styles.getPropertyValue("--gold").trim() || "#d3a13c";
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

function fmtDb(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(1)} dB` : "–";
}

/** The database-style DR integer; absent rather than wrong when the
 *  procedure declines to speak (silence, sub-floor, clamped). */
function DrBadge({ dr }: { dr: number }): React.JSX.Element | null {
  if (dr <= 0) return null;
  return (
    <span title="Dynamic range (the TT DR procedure, as in the DR database)">{` · DR${dr}`}</span>
  );
}

/** The Stream tab's panel view: envelopes, playhead, click-to-seek, stats. */
export function Waveform({
  serverUdn,
  objectId,
}: {
  serverUdn: string;
  objectId: string;
}): React.JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const enabled = useStore((s) => s.settings.waveforms);
  const analysis = usePeaks(enabled ? serverUdn : null, enabled ? objectId : null);
  const progress = useProgress();
  const duration = useStore((s) => s.playState?.metadata?.duration ?? null);

  useEffect(() => {
    if (canvasRef.current && analysis && analysis !== "loading")
      draw(canvasRef.current, analysis, progress, { strip: false, style: "bars" });
  }, [analysis, progress]);

  if (analysis === null) return null;
  return (
    <div data-waveform className="pt-1">
      <div className="microlabel mb-1.5">waveform</div>
      {analysis === "loading" ? (
        <div className="h-12 flex items-center text-[11.5px] text-faint motion-safe:animate-pulse">
          Reading the file…
        </div>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            className="w-full h-12 block cursor-pointer"
            onClick={(e) => {
              if (duration == null || duration <= 0) return;
              const r = e.currentTarget.getBoundingClientRect();
              const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
              holdSeek(pct);
              void tt.command({ type: "seek", positionSecs: Math.round(pct * duration) });
            }}
          />
          <div className="mt-1.5 font-mono text-[10.5px] text-faint">
            peak {fmtDb(analysis.peakDb)} · rms {fmtDb(analysis.rmsDb)} · crest{" "}
            {fmtDb(analysis.crestDb)}
            <DrBadge dr={analysis.dr} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Display mode's bottom strip: the waveform stands in for the progress bar
 * when peaks exist; the caller renders its plain bar otherwise. Quiet on
 * purpose — display mode is a face, not a console.
 */
export function DisplayWaveform({
  progress,
  fallback,
}: {
  progress: number;
  fallback: React.JSX.Element;
}): React.JSX.Element {
  const enabled = useStore((s) => s.settings.waveforms && s.settings.displayWaveform);
  const ref = usePlayingFileRef();
  const analysis = usePeaks(enabled ? (ref?.serverUdn ?? null) : null, ref?.objectId ?? null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ready = analysis != null && analysis !== "loading";

  useEffect(() => {
    if (canvasRef.current && ready)
      draw(canvasRef.current, analysis, progress, { strip: true, style: "envelope" });
  }, [analysis, ready, progress]);

  // CONSTANT GEOMETRY: the strip's 40px band exists from first paint, with
  // the plain bar rendering at its foot until (unless) peaks arrive — the
  // waveform fades into reserved space instead of landing under the lyric
  // line mid-track (seen live, 2026-08-30).
  return (
    <div className="absolute inset-x-0 bottom-0 h-10">
      {ready ? (
        <div className="h-full px-3">
          <canvas ref={canvasRef} className="w-full h-full block" />
        </div>
      ) : (
        fallback
      )}
    </div>
  );
}

/** Under the album art on Now Playing: the waveform as pure form — playhead,
 *  no controls, absent (zero height) when the track has no peaks. */
export function NowPlayingWaveform(): React.JSX.Element | null {
  const enabled = useStore((s) => s.settings.waveforms && s.settings.waveformNowPlaying);
  const ref = usePlayingFileRef();
  const analysis = usePeaks(enabled ? (ref?.serverUdn ?? null) : null, ref?.objectId ?? null);
  const progress = useProgress();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ready = analysis != null && analysis !== "loading";

  useEffect(() => {
    // The envelope, like fullscreen: at art width its silhouette reads as
    // form; position shows as the played/unplayed split (user, 2026-08-30).
    if (canvasRef.current && ready)
      draw(canvasRef.current, analysis, progress, { strip: false, style: "envelope" });
  }, [analysis, ready, progress]);

  if (!ready) return null;
  return (
    <div data-np-waveform className="pt-5">
      <canvas ref={canvasRef} className="w-full h-16 block" />
      <div className="mt-2 text-center font-mono text-[10.5px] text-faint">
        peak {fmtDb(analysis.peakDb)} · rms {fmtDb(analysis.rmsDb)} · crest{" "}
        {fmtDb(analysis.crestDb)}
        <DrBadge dr={analysis.dr} />
      </div>
    </div>
  );
}

/** The seek bar's waveform track — the marquee consumer, previewed. Returns
 *  a track renderer for the Slider when both toggles allow and the playing
 *  track has peaks; null falls the bar back to its plain line. */
export function useSeekWaveform(): ((shown: number) => React.JSX.Element) | null {
  const enabled = useStore((s) => s.settings.waveforms && s.settings.waveformSeekBar);
  const ref = usePlayingFileRef();
  const analysis = usePeaks(enabled ? (ref?.serverUdn ?? null) : null, ref?.objectId ?? null);
  if (!enabled || analysis == null || analysis === "loading") return null;
  const track = (shown: number): React.JSX.Element => (
    <SeekTrack analysis={analysis} shown={shown} />
  );
  return track;
}

function SeekTrack({ analysis, shown }: { analysis: Analysis; shown: number }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    // Bars stay for the CONTROL — segments read as grabbable — but at the
    // pre-upgrade density: ~2.25px pitch reproduces the 240-bucket look at
    // the bar's usual width; the finer pitch read as busy (user, 2026-08-30).
    if (canvasRef.current)
      draw(canvasRef.current, analysis, shown, { strip: true, style: "bars", pitch: 2.25 });
  }, [analysis, shown]);
  return <canvas ref={canvasRef} className="w-full h-8 block" data-seek-waveform />;
}
