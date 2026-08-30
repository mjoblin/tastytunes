import { useEffect, useRef, useState } from "react";
import { tt } from "@/api";
import { useStore } from "@/store";
import { nowPlayingInfoTarget } from "@/lib/mediaInfo";

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
 * only: peak/RMS/crest are what this decode truly measures — "LUFS" and
 * "DR" wait for the real R128 analysis pass.
 */

const BUCKETS = 240;

interface Analysis {
  peak: Float32Array;
  rms: Float32Array;
  peakDb: number;
  rmsDb: number;
  crestDb: number;
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
      const data = audio.getChannelData(0);
      const peak = new Float32Array(BUCKETS);
      const rms = new Float32Array(BUCKETS);
      const per = Math.max(1, Math.floor(data.length / BUCKETS));
      let globalPeak = 0;
      let globalSumSq = 0;
      let globalN = 0;
      for (let b = 0; b < BUCKETS; b++) {
        const start = b * per;
        const end = Math.min(start + per, data.length);
        // Sample within the bucket rather than touching every frame.
        const step = Math.max(1, Math.floor((end - start) / 400));
        let max = 0;
        let sumSq = 0;
        let n = 0;
        for (let i = start; i < end; i += step) {
          const v = data[i];
          const a = Math.abs(v);
          if (a > max) max = a;
          sumSq += v * v;
          n++;
        }
        peak[b] = max;
        rms[b] = n > 0 ? Math.sqrt(sumSq / n) : 0;
        if (max > globalPeak) globalPeak = max;
        globalSumSq += sumSq;
        globalN += n;
      }
      const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);
      const peakDb = db(globalPeak);
      const rmsDb = db(globalN > 0 ? Math.sqrt(globalSumSq / globalN) : 0);
      return { peak, rms, peakDb, rmsDb, crestDb: peakDb - rmsDb };
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

function draw(
  canvas: HTMLCanvasElement,
  a: Analysis,
  progress: number | null,
  strip: boolean,
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  const styles = getComputedStyle(document.documentElement);
  const gold = styles.getPropertyValue("--gold").trim() || "#d3a13c";
  const barW = w / a.peak.length;
  const mid = h / 2;
  for (let i = 0; i < a.peak.length; i++) {
    const played = progress != null && i / a.peak.length <= progress;
    const x = i * barW;
    const bw = Math.max(0.5, barW - 0.75);
    // Peak envelope: the pale outline of what the track could do.
    ctx.fillStyle = gold;
    ctx.globalAlpha = strip ? (played ? 0.4 : 0.16) : played ? 0.5 : 0.24;
    const ph = Math.max(0.5, a.peak[i] * mid);
    ctx.fillRect(x, mid - ph, bw, ph * 2);
    // RMS envelope: the solid gold of what it actually does.
    ctx.globalAlpha = strip ? (played ? 1 : 0.4) : played ? 1 : 0.55;
    const rh = Math.max(0.5, a.rms[i] * mid);
    ctx.fillRect(x, mid - rh, bw, rh * 2);
  }
  if (progress != null && !strip) {
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = gold;
    ctx.fillRect(progress * w - 0.5, 0, 1, h);
  }
}

function fmtDb(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(1)} dB` : "–";
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
  const analysis = usePeaks(serverUdn, objectId);
  const progress = useProgress();
  const duration = useStore((s) => s.playState?.metadata?.duration ?? null);

  useEffect(() => {
    if (canvasRef.current && analysis && analysis !== "loading")
      draw(canvasRef.current, analysis, progress, false);
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
  const ref = usePlayingFileRef();
  const analysis = usePeaks(ref?.serverUdn ?? null, ref?.objectId ?? null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ready = analysis != null && analysis !== "loading";

  useEffect(() => {
    if (canvasRef.current && ready) draw(canvasRef.current, analysis, progress, true);
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
  const ref = usePlayingFileRef();
  const analysis = usePeaks(ref?.serverUdn ?? null, ref?.objectId ?? null);
  const progress = useProgress();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ready = analysis != null && analysis !== "loading";

  useEffect(() => {
    if (canvasRef.current && ready) draw(canvasRef.current, analysis, progress, false);
  }, [analysis, ready, progress]);

  if (!ready) return null;
  return (
    <div data-np-waveform className="pt-4">
      <canvas ref={canvasRef} className="w-full h-8 block" />
    </div>
  );
}
