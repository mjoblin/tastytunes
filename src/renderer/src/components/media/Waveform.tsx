import { useEffect, useRef, useState } from "react";
import { tt } from "@/api";
import { cx, fmtTime } from "@/lib/format";
import { useStore } from "@/store";
import { AudioLines } from "lucide-react";
import { FACT_SEP } from "@/lib/mediaFacts";
import {
  absentLine,
  type Analysis,
  type KnownAnalysis,
  retryAnalysis,
  stalled,
  usePeaks,
  usePlayingDr,
  usePlayingFileRef,
} from "./waveformAnalysis";
import { draw } from "./waveformDraw";

// A TRACK'S WAVEFORM, its faces: the Stream tab's panel, display mode's strip, Now Playing's, the
// Info window's, the playback bar's seek track, and the DR and loudness chips. The analysis they draw
// lives in waveformAnalysis.ts (the module's account of how a track is measured and kept is there),
// the drawing in waveformDraw.ts (0.15.0, the hygiene pass).

/** How far a file being measured has got, in place of its figures (0.14.0, his A1). */
function MeasuringLine({ at }: { at: { ready: number; of: number } }): React.JSX.Element {
  return (
    <div className="mt-1.5 font-mono text-[10.5px] text-faint" data-waveform-measuring>
      Measuring{FACT_SEP}
      {Math.round((at.ready / at.of) * 100)}%
    </div>
  );
}

/** The absent line, with Try again when the file's server stopped sending it (0.14.0, his A3). */
function AbsentLine({
  serverUdn,
  objectId,
  onRetry,
}: {
  serverUdn: string | null;
  objectId: string | null;
  /** Measures the file once the stall is forgotten (Info's Analyze); every surface drawing the
   *  file asks again on its own. */
  onRetry?: () => void;
}): React.JSX.Element {
  const isStalled = !!serverUdn && !!objectId && stalled.get(`${serverUdn}|${objectId}`) === true;
  return (
    <div className="flex items-baseline gap-2 text-[11.5px] text-faint" data-waveform-absent>
      <span className="min-w-0">{absentLine(serverUdn, objectId)}</span>
      {isStalled && (
        <button
          data-waveform-retry
          onClick={() => {
            if (!serverUdn || !objectId) return;
            retryAnalysis(serverUdn, objectId);
            onRetry?.();
          }}
          // no transition: Info's frosted shell fades as a whole (S11)
          className="shrink-0 rounded-md px-1.5 py-px ring-1 ring-edge text-dim hover:bg-veil2 hover:text-ink"
        >
          Try again
        </button>
      )}
    </div>
  );
}

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

/** Integrated loudness as the standard writes it: one decimal, LUFS. */
export function fmtLufs(v: number): string {
  return `${v.toFixed(1)} LUFS`;
}

function fmtDb(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(1)} dB` : "–";
}

/** The database-style DR integer; absent rather than wrong when the
 *  procedure declines to speak (silence, sub-floor, clamped). */
/** The database's traffic-light convention (red = crushed, green = open;
 *  DR14 was the campaign's target), translated into the house palette:
 *  ember for the loudness-war band, the app's own gold for the middle,
 *  sage for a genuinely dynamic master. ONE home for the bands (S21) —
 *  the stats badge and Now Playing's format chip both read it. */
export function drTone(dr: number): { tone: string; word: string } {
  if (dr <= 7) return { tone: "#bc5a45", word: "compressed" };
  if (dr <= 13) return { tone: "rgb(var(--gold-rgb))", word: "moderate dynamics" };
  return { tone: "#6f9a68", word: "dynamic" };
}

export function DrBadge({
  dr,
  className,
  lufs = null,
  titled = true,
}: {
  dr: number;
  /** Integrated loudness, when known — the tooltip carries it beside the band word. */
  lufs?: number | null;
  /** Overrides the default ml-2.5 (row cells manage their own spacing). */
  className?: string;
  /** False where the line around it carries the tip (an album card's format line). */
  titled?: boolean;
}): React.JSX.Element | null {
  if (dr <= 0) return null;
  const { tone, word } = drTone(dr);
  return (
    <span
      title={
        titled
          ? `Dynamic range (the TT DR procedure, as in the DR database): ${word}${lufs != null ? ` · loudness ${fmtLufs(lufs)}` : ""}`
          : undefined
      }
      className={`rounded px-1 py-px ${className ?? "ml-2.5"}`}
      style={{
        color: tone,
        backgroundColor: `color-mix(in srgb, ${tone} 12%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone} 35%, transparent)`,
      }}
    >
      {`DR${dr}`}
    </span>
  );
}

/** The Stream tab's panel view: envelopes, playhead, click-to-seek, stats. */
export function Waveform({
  serverUdn,
  objectId,
  contentKey = null,
}: {
  serverUdn: string;
  objectId: string;
  contentKey?: string | null;
}): React.JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const enabled = useStore((s) => s.settings.waveforms);
  const analysis = usePeaks(enabled ? serverUdn : null, enabled ? objectId : null, contentKey);
  const progress = useProgress();
  const duration = useStore((s) => s.playState?.metadata?.duration ?? null);

  useEffect(() => {
    if (canvasRef.current && analysis && analysis !== "loading")
      draw(canvasRef.current, analysis, progress, { strip: false, style: "bars" });
  }, [analysis, progress]);

  // Absence explains itself here, quietly — the one place a curious user
  // looks when a track has no waveform (a 71MB track met the fetch cap in
  // silence, 2026-09-01); since 0.12.0 a file past the size limit says so
  // (absentLine), the rest name what is left.
  if (analysis === null)
    return enabled ? (
      <div data-waveform className="pt-1">
        <div className="microlabel mb-1.5">waveform</div>
        <AbsentLine serverUdn={serverUdn} objectId={objectId} />
      </div>
    ) : null;
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
          {analysis.partial ? (
            // the file still arriving (0.14.0, his A1): how far, in place of the figures
            <MeasuringLine at={analysis.partial} />
          ) : (
            <div className="mt-1.5 font-mono text-[10.5px] text-faint">
              peak {fmtDb(analysis.peakDb)}
              {FACT_SEP}rms {fmtDb(analysis.rmsDb)}
              {FACT_SEP}crest {fmtDb(analysis.crestDb)}
              {analysis.lufs != null && `${FACT_SEP}${fmtLufs(analysis.lufs)}`}
            </div>
          )}
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
  duration,
  fallback,
  onSeek,
}: {
  progress: number;
  /** The track's seconds, for the hover's target time. */
  duration?: number;
  fallback: React.JSX.Element;
  /** A click on the strip seeks to that share of the track (like the Stream tab's panel). */
  onSeek?: (pct: number) => void;
}): React.JSX.Element {
  /** Where the pointer hovers over the strip: its share of the width, or null. */
  const [hover, setHover] = useState<number | null>(null);
  const enabled = useStore(
    (s) => s.settings.waveforms && s.settings.displayWaveform && s.settings.waveformSeen,
  );
  const ref = usePlayingFileRef();
  const analysis = usePeaks(
    enabled ? (ref?.serverUdn ?? null) : null,
    ref?.objectId ?? null,
    ref?.contentKey ?? null,
  );
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
    // z-10: the hover tip stands above the strip's band, where the scene canvases would
    // otherwise paint over it (they sit earlier in the DOM but are appended after mount)
    <div data-display-waveform className="absolute inset-x-0 bottom-0 z-10 h-10">
      {ready ? (
        <div
          className={cx("relative h-full px-3", onSeek && "cursor-pointer")}
          onMouseMove={
            onSeek
              ? (e) => {
                  const rect = canvasRef.current?.getBoundingClientRect();
                  if (!rect || rect.width <= 0) return;
                  setHover(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
                }
              : undefined
          }
          onMouseLeave={() => setHover(null)}
          onClick={
            onSeek
              ? (e) => {
                  const rect = canvasRef.current?.getBoundingClientRect();
                  if (!rect || rect.width <= 0) return;
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  holdSeek(pct);
                  onSeek(pct);
                }
              : undefined
          }
        >
          <canvas ref={canvasRef} className="w-full h-full block" />
          {hover != null && onSeek && (
            // the hover: a hairline where the pointer is and the time it would seek to, above
            // the strip (the strip is the seek bar here, so it says what a click would do)
            <>
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-ink/40"
                style={{ left: `calc(0.75rem + ${hover} * (100% - 1.5rem))` }}
              />
              <div
                data-display-seek-tip
                className="pointer-events-none absolute bottom-full mb-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-panel/90 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-ink ring-1 ring-edge"
                style={{ left: `calc(0.75rem + ${hover} * (100% - 1.5rem))` }}
              >
                {duration != null ? fmtTime(hover * duration) : `${Math.round(hover * 100)}%`}
              </div>
            </>
          )}
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
  const analysis = usePeaks(
    enabled ? (ref?.serverUdn ?? null) : null,
    ref?.objectId ?? null,
    ref?.contentKey ?? null,
  );
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
        peak {fmtDb(analysis.peakDb)}
        {FACT_SEP}rms {fmtDb(analysis.rmsDb)}
        {FACT_SEP}crest {fmtDb(analysis.crestDb)}
        {analysis.lufs != null && `${FACT_SEP}${fmtLufs(analysis.lufs)}`}
      </div>
    </div>
  );
}

/**
 * The Info modal's waveform, directly under the header — the contemplation
 * surface the under-art envelope was made for. Shown when the analysis is
 * KNOWN; otherwise an Analyze audio button stands in its place (the album
 * menu's verb, so the vocabulary stays one). Absence renders as an offer.
 * THE PLACEMENT RULE (2026-09-01): the waveform lives directly beneath the
 * art wherever a track is being studied — Now Playing (for those who turn
 * it on), the Stream tab, and here. The stats row is peak/RMS/crest only:
 * measurements of the picture. DR is a fact about the master and lives with
 * the file facts (the header chips, the Format rows) — one home per fact.
 */
export function InfoWaveform({
  state,
  partial = null,
  onAnalyze,
  serverUdn = null,
  objectId = null,
}: {
  state: KnownAnalysis;
  /** What Analyze has measured so far, while the file arrives. */
  partial?: Analysis | null;
  onAnalyze(): void;
  /** The file's location, for why it has no waveform (absentLine). */
  serverUdn?: string | null;
  objectId?: string | null;
}): React.JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shown = state === "loading" ? partial : state != null && state !== "unknown" ? state : null;
  useEffect(() => {
    // A study view, not a playhead: the whole envelope wears the "played"
    // brightness (progress 1) — nothing here is dim for being unheard.
    if (canvasRef.current && shown)
      draw(canvasRef.current, shown, 1, { strip: false, style: "envelope" });
  }, [shown]);

  if (state === "loading" && !partial) return null;
  return (
    <div className="mt-4" data-info-waveform>
      <div className="microlabel mb-1.5">waveform</div>
      {state === "unknown" ? (
        <button
          data-info-analyze
          onClick={onAnalyze}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/80 text-[12px] text-dim hover:text-ink hover:bg-veil transition-colors"
        >
          <AudioLines size={13} /> Analyze audio
        </button>
      ) : state === null ? (
        <AbsentLine serverUdn={serverUdn} objectId={objectId} onRetry={onAnalyze} />
      ) : state === "loading" ? (
        // the file still arriving (0.14.0, his A1): drawn so far, how far in place of the figures
        <>
          <canvas ref={canvasRef} className="w-full h-16 block" />
          {partial?.partial && <MeasuringLine at={partial.partial} />}
        </>
      ) : (
        <>
          <canvas ref={canvasRef} className="w-full h-16 block" />
          <div className="mt-1.5 flex items-center gap-2">
            <div className="min-w-0 flex-1 font-mono text-[10.5px] text-faint">
              peak {fmtDb(state.peakDb)}
              {FACT_SEP}rms {fmtDb(state.rmsDb)}
              {FACT_SEP}crest {fmtDb(state.crestDb)}
              {state.lufs != null && `${FACT_SEP}${fmtLufs(state.lufs)}`}
            </div>
            {/* AN EARLIER VERSION'S MEASUREMENT (0.12.0, his ask for a way to re-measure one
                track): the verb that measures it again, an icon at the end of the measurements'
                line with the reason in its tip, taking no row of its own (his call); its tempo
                and key say nothing meanwhile (shared/model's currentFeatures) */}
            {state.outdated && (
              <button
                data-info-outdated
                data-info-analyze
                onClick={onAnalyze}
                aria-label="Analyze audio again"
                data-tip="Measured by an earlier version of TastyTunes. Analyze audio again."
                // no transition inside the frosted shell (S11): the shell fades as a whole
                className="tip-top tip-end -my-1 shrink-0 rounded-md p-1 text-dim hover:bg-veil2 hover:text-ink"
              >
                <AudioLines size={14} />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * DR as a format chip — the .badge grammar, band-tinted. Its HOME is with
 * the file facts, because DR is a property of the master beside codec, rate
 * and depth: Now Playing's chip row, both Info modals' header chips, the
 * Format sections' Dynamic range row. Never a second time beside a waveform
 * (user call, 2026-09-01: one home per fact).
 */
/** The album's (or track's) integrated loudness as a chip beside DR — neutral
 *  tone: a loudness is a fact about a master, not a verdict. */
export function LufsChip({ lufs }: { lufs: number }): React.JSX.Element {
  return (
    <span
      className="badge"
      data-lufs-chip
      title="Integrated loudness (EBU R128 / ITU-R BS.1770), gated across the whole album"
    >
      {fmtLufs(lufs)}
    </span>
  );
}

export function DrChip({ dr }: { dr: number }): React.JSX.Element | null {
  if (dr <= 0) return null;
  const { tone, word } = drTone(dr);
  return (
    <span
      className="badge"
      data-dr-chip
      title={`Dynamic range (the TT DR procedure, as in the DR database): ${word}`}
      style={{
        color: tone,
        borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${tone} 10%, transparent)`,
      }}
    >
      {`DR${dr}`}
    </span>
  );
}

/** Now Playing's format row wears the playing track's DR — at the END of the
 *  chips, before the lamp: a verdict about the master beside the verdict
 *  about the signal, facts first, the lamp still the row's closing mark; a
 *  late arrival nudges only the lamp (user call, 2026-09-01). */
export function PlayingDrChip(): React.JSX.Element | null {
  const dr = usePlayingDr();
  return dr == null ? null : <DrChip dr={dr} />;
}

/** The seek bar's waveform track — the marquee consumer, previewed. Returns
 *  a track renderer for the Slider when both toggles allow and the playing
 *  track has peaks; null falls the bar back to its plain line. */
export function useSeekWaveform(): ((shown: number) => React.JSX.Element) | null {
  const enabled = useStore((s) => s.settings.waveforms && s.settings.waveformSeekBar);
  const ref = usePlayingFileRef();
  const analysis = usePeaks(
    enabled ? (ref?.serverUdn ?? null) : null,
    ref?.objectId ?? null,
    ref?.contentKey ?? null,
  );
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
  const p = analysis.partial;
  return (
    <canvas
      ref={canvasRef}
      className="w-full h-8 block"
      data-seek-waveform
      data-seek-waveform-partial={p ? Math.round((p.ready / p.of) * 100) : undefined}
    />
  );
}
