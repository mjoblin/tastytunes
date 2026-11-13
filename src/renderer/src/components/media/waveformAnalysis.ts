// A TRACK'S ANALYSIS: its store, its measuring and the hooks every surface reads it through. Moved
// out of Waveform.tsx as it was (0.15.0: the file had grown from 873 lines to
// 1,265); Waveform.tsx keeps the faces that draw it, waveformDraw.ts the drawing itself.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { tt } from "@/api";
import { useStore } from "@/store";
import { nowPlayingInfoTarget } from "@/lib/mediaInfo";
import { useReadyIndexSig } from "@/hooks/useIndexPools";
import { sniffSampleRate } from "@/lib/audioHeader";
import { stripFromStored, stripToStored } from "@/lib/featureStrip";
import { onsetsFromStored, onsetsToStored } from "@/lib/onsets";
import { FEATURES_VERSION, featuresFromStored, featuresToStored } from "@/lib/features";
import { measureOffThread, measureStreamOffThread } from "@/lib/measureClient";
import type { Measured } from "@/lib/measure";
import {
  audioAnalysisKey,
  currentFeatures,
  fmtBytes,
  keyName,
  tempoBpm,
  type AnalysisFeatures,
  type AudioAnalysis,
} from "@shared/model";
import { Lru } from "@/lib/lru";

/**
 * EXPERIMENT (0.7 exploration): waveforms from the
 * file's own bytes. Main fetches the audio from the LOCAL media server; this
 * module decodes with WebAudio and keeps TWO envelopes per track — peak and
 * RMS — so the drawing shows dynamics, not just shape: a crushed master
 * reads as a solid brick, an open one as gold hills inside a pale outline.
 * Everything is best-effort and silent on failure; analyses are cached
 * twice over: in-flight promises for the session (StrictMode's double
 * effects share one fetch), and main's disk cache under CONTENT identity —
 * a track analyzed once (played, or swept by Analyze audio) never fetches
 * again. lib/audioAnalysis holds the album sweep.
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
 * stretching a fixed bucket count into 10px slabs.
 */

const CAPTURE_BUCKETS = 1200;

/** What a decoded track measures as (lib/measure), the shape every surface reads. */
/** A measured track; `outdated` marks a stored analysis an earlier version wrote (a measurement
 *  it lacks, or features of another version): Info offers Analyze audio again, which re-measures
 *  it (analyzeTrack), as playing it does. */
export type Analysis = Measured & {
  outdated?: boolean;
  /** Still being measured (0.14.0: the waveform fills in as the file arrives): the
   *  envelopes' first `ready` of `of` buckets hold their values; every other figure is empty
   *  until it is done. Never stored. */
  partial?: { ready: number; of: number };
};

// decoded analyses hold every envelope: the last 48 tracks (lib/lru)
const cache = new Lru<string, Promise<Analysis | null>>(48);
// A read that came back empty is NOT kept as the answer for the session: the
// disk is asked by content on every call (an Analyze audio sweep may have
// written this track's analysis under its content key since; a track that had
// resolved to the unreadable USB copy showed no DR and no scene until a
// restart), and the network is held off for a minute.
const failedAt = new Lru<string, number>(500);
const FAILED_MEMO_MS = 60_000;
// files main refused for their size (main/ipc/audio), so the absent line can say so
const tooLarge = new Lru<string, { bytes: number; maxBytes: number }>(500);
// files whose server stopped sending (0.14.0: a stall is a silence, caught on its own),
// so the absent line can say so and offer to try again
export const stalled = new Lru<string, true>(500);

// A FILE BEING MEASURED (0.14.0, analysis with no size limit): the waveform's buckets so far, by
// location, for every surface that draws it while the file arrives, and the way to stop
// a playing track's measuring when it is skipped, unless something holds it: Info open on
// the track, an Analyze audio sweep, a forced measurement.
type Live = { ready: number; peak: Float32Array; rms: Float32Array };
const live = new Map<string, Live>();
const liveListeners = new Set<() => void>();
const setLive = (key: string, v: Live | null): void => {
  if (v) live.set(key, v);
  else live.delete(key);
  for (const l of liveListeners) l();
};
const subscribeLive = (l: () => void): (() => void) => {
  liveListeners.add(l);
  return () => liveListeners.delete(l);
};
const controllers = new Map<string, AbortController>();
const holds = new Map<string, number>();
// a Try again by location: every surface drawing the file asks once more
const retries = new Map<string, number>();

/** Keep a track's measuring going while the caller lives (Info open on it). */
export function holdAnalysis(serverUdn: string, objectId: string): () => void {
  const key = `${serverUdn}|${objectId}`;
  holds.set(key, (holds.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (holds.get(key) ?? 1) - 1;
    if (n > 0) holds.set(key, n);
    else holds.delete(key);
  };
}

/** Stop a track's measuring (a skip), unless something holds it; the next play starts afresh. */
export function stopAnalysis(serverUdn: string, objectId: string): void {
  const key = `${serverUdn}|${objectId}`;
  if (holds.has(key)) return;
  controllers.get(key)?.abort();
}

/** Try a stalled file again: forget the stall, and every surface drawing it measures it again. */
export function retryAnalysis(serverUdn: string, objectId: string): void {
  const key = `${serverUdn}|${objectId}`;
  stalled.delete(key);
  failedAt.delete(key);
  cache.delete(key);
  peeked.delete(key);
  retries.set(key, (retries.get(key) ?? 0) + 1);
  for (const l of liveListeners) l();
}

/** What a file measured in pieces has so far, by location, while `key` is given. */
function useLivePartial(key: string | null): Analysis | null {
  const sofar = useSyncExternalStore(subscribeLive, () => (key ? (live.get(key) ?? null) : null));
  return useMemo(() => (sofar ? partialOf(sofar) : null), [sofar]);
}

/** The analysis so far, while a file is measured in pieces: the envelopes' ready buckets. */
function partialOf(l: Live): Analysis {
  return {
    peak: l.peak,
    rms: l.rms,
    peakDb: -Infinity,
    rmsDb: -Infinity,
    crestDb: 0,
    dr: 0,
    lufs: null,
    lra: null,
    truePeakDb: null,
    loudHist: null,
    strip: null,
    onsets: null,
    features: null,
    partial: { ready: l.ready, of: l.peak.length },
  };
}

/** Whether any file is being measured now (the album being played waits its turn behind the
 *  playing track's own measuring, Info's and a sweep's: lib/albumOnPlay). */
export function measuringNow(): boolean {
  return controllers.size > 0;
}

// AN UNHURRIED READ (0.16.0): a measuring nobody is waiting on (the album being played,
// lib/albumOnPlay) asks for the file's next piece (main hands at most 2 MB a read) no sooner than
// PACE_MS after the last, so it reads no faster than 2 MB a second beside the streamer's own read
// of the same server; a server that is read no faster sends no faster
const PACE_MS = 1000;

/** A file measured in pieces (FLAC, WAV, AIFF): its analysis; "whole" when only the whole-file
 *  decode reads it; null when it couldn't be measured (`stalled` says when the server stopped). */
async function measureInPieces(
  serverUdn: string,
  objectId: string,
  key: string,
  signal: AbortSignal,
  pace: boolean,
): Promise<Analysis | "whole" | null> {
  const opened = await tt.audioStreamOpen(serverUdn, objectId).catch(() => null);
  if (!opened) return null;
  let nextRead = 0;
  const read = async (): ReturnType<typeof tt.audioStreamRead> => {
    if (pace) {
      const wait = nextRead - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      nextRead = Date.now() + PACE_MS;
    }
    return tt.audioStreamRead(opened.id);
  };
  try {
    const out = await measureStreamOffThread(read, CAPTURE_BUCKETS, (p) => setLive(key, p), signal);
    if ("measured" in out) return out.measured;
    if ("whole" in out) return "whole";
    if (out.failed === "stalled") stalled.set(key, true);
    return null;
  } finally {
    setLive(key, null);
    void tt.audioStreamClose(opened.id).catch(() => {});
  }
}

/** Why a track has no waveform, in the absent line's words (0.12.0: the reason crosses the IPC
 *  now; a file past the size limit says so instead of naming two possible causes). */
export function absentLine(serverUdn: string | null, objectId: string | null): string {
  const key = serverUdn && objectId ? `${serverUdn}|${objectId}` : null;
  if (key && stalled.get(key)) return "No waveform for this file. The server stopped sending it.";
  const big = key ? tooLarge.get(key) : undefined;
  return big
    ? `No waveform for this file. At ${fmtBytes(big.bytes)} it's larger than TastyTunes can analyze (${fmtBytes(big.maxBytes)}).`
    : "No waveform for this file. It couldn't be read or decoded.";
}

// Disk shape round trip: envelopes quantized to thousandths (the JSON
// stays humane); non-finite dB (silence) rides as null.
const QUANT = 1000;
function toStored(a: Analysis): AudioAnalysis {
  const num = (v: number): number | null => (Number.isFinite(v) ? v : null);
  return {
    dr: a.dr,
    peakDb: num(a.peakDb),
    rmsDb: num(a.rmsDb),
    crestDb: num(a.crestDb),
    peakQ: Array.from(a.peak, (v) => Math.round(v * QUANT)),
    rmsQ: Array.from(a.rms, (v) => Math.round(v * QUANT)),
    lufs: a.lufs,
    lra: a.lra,
    truePeakDb: a.truePeakDb,
    loudHist: a.loudHist,
    strip: a.strip ? stripToStored(a.strip) : null,
    onsets: a.onsets ? onsetsToStored(a.onsets) : null,
    features: a.features ? featuresToStored(a.features) : null,
  };
}
/** True for a stored analysis written before the loudness fields existed
 *  (the field is absent; a measured-but-null loudness is stored as null). */
const predatesLoudness = (st: AudioAnalysis): boolean => st.loudHist === undefined;
/** Likewise for the feature strip (0.8.0's scenes). */
const predatesStrip = (st: AudioAnalysis): boolean => st.strip === undefined;
/** And for the drum onsets (display mode's hits). */
const predatesOnsets = (st: AudioAnalysis): boolean => st.onsets === undefined;
/** And for the music features, which also re-measure when their version moved on. */
const predatesFeatures = (st: AudioAnalysis): boolean =>
  st.features === undefined || (st.features != null && st.features.version !== FEATURES_VERSION);

function fromStored(st: AudioAnalysis): Analysis {
  return {
    dr: st.dr,
    peakDb: st.peakDb ?? -Infinity,
    rmsDb: st.rmsDb ?? -Infinity,
    crestDb: st.crestDb ?? -Infinity,
    peak: Float32Array.from(st.peakQ, (v) => v / QUANT),
    rms: Float32Array.from(st.rmsQ, (v) => v / QUANT),
    lufs: st.lufs ?? null,
    lra: st.lra ?? null,
    truePeakDb: st.truePeakDb ?? null,
    loudHist: st.loudHist ?? null,
    strip: st.strip ? stripFromStored(st.strip) : null,
    onsets: st.onsets ? onsetsFromStored(st.onsets) : null,
    // an older version's features say nothing (shared/model's currentFeatures): a peek (Info,
    // never re-measuring) shows no tempo or key for them until the track is measured again
    outdated:
      predatesLoudness(st) || predatesStrip(st) || predatesOnsets(st) || predatesFeatures(st),
    features: currentFeatures(st.features)
      ? featuresFromStored(st.features as AnalysisFeatures)
      : null,
  };
}

/** A stored analysis the current version would write the same: every measurement there, the
 *  features its version. An entry from before loudness (0.7.0's cache shape) is incomplete and
 *  is measured again ONCE, on the next play or Analyze audio, rather than carrying the gap
 *  forever (re-analysis showed only DR); likewise the later measurements. */
const isCurrent = (st: AudioAnalysis): boolean =>
  !predatesLoudness(st) && !predatesStrip(st) && !predatesOnsets(st) && !predatesFeatures(st);

/** Whether a track's stored analysis is current (Analyze audio's "is there work to do":
 *  lib/audioAnalysis measures again what is current only when nothing else needs it). */
export async function storedIsCurrent(contentKey: string): Promise<boolean> {
  const st = await tt.audioAnalysisGet(contentKey).catch(() => null);
  return st != null && isCurrent(st);
}

/** The analysis engine, exported for the Analyze-audio sweep
 *  (lib/audioAnalysis). contentKey engages the disk cache; the in-memory
 *  key stays LOCATION (udn|objectId), scoped to the session. `force` measures
 *  the file again even when a current analysis is stored (Analyze audio with
 *  nothing else to do, 0.12.0: a file replaced under the same title, artist,
 *  album and length keeps its old analysis otherwise). `pace` reads the file at the unhurried
 *  pace (PACE_MS), for a measuring nobody is waiting on. */
export function analyzeTrack(
  serverUdn: string,
  objectId: string,
  contentKey: string | null = null,
  {
    force = false,
    keep = false,
    pace = false,
  }: { force?: boolean; keep?: boolean; pace?: boolean } = {},
): Promise<Analysis | null> {
  const key = `${serverUdn}|${objectId}`;
  const hit = force ? undefined : cache.get(key);
  if (hit) return hit;
  // a forced measurement: what a peek last found is old news
  if (force) peeked.delete(key);
  const p = (async (): Promise<Analysis | null> => {
    if (contentKey && !force) {
      const stored = await tt.audioAnalysisGet(contentKey);
      if (stored && isCurrent(stored)) return fromStored(stored);
    }
    const failed = failedAt.get(key);
    if (!force && failed != null && Date.now() - failed < FAILED_MEMO_MS) return null;
    // FLAC, WAV and AIFF in pieces (0.14.0): no size limit, the waveform filling in as it goes;
    // a measuring something else wants (a sweep, a forced one) holds itself against a skip
    const ac = new AbortController();
    controllers.set(key, ac);
    const release = keep || force ? holdAnalysis(serverUdn, objectId) : null;
    let pieces: Analysis | "whole" | null;
    try {
      pieces = await measureInPieces(serverUdn, objectId, key, ac.signal, pace);
    } finally {
      release?.();
      if (controllers.get(key) === ac) controllers.delete(key);
    }
    if (ac.signal.aborted) throw new Error("cancelled");
    if (pieces !== "whole") {
      if (pieces && contentKey) void tt.audioAnalysisPut(contentKey, toStored(pieces));
      return pieces;
    }
    const got = await tt.expTrackAudio(serverUdn, objectId);
    if (!got) return null;
    if (!ArrayBuffer.isView(got)) {
      tooLarge.set(key, got.tooLarge);
      return null;
    }
    // the bytes as they came: no copy (a 24/192 file is hundreds of MB, and its samples as
    // many again; main/ipc/audio's cap is set by what the decode holds)
    const u8 = got;
    // NATIVE RATE (2026-09-01): decodeAudioData resamples to its context's
    // rate, and at the device's 48k a 44.1k FLAC came back with a +0.5 dB
    // "peak" and a DR computed on interpolated samples — the harness had
    // validated the math on ffmpeg's native decode, the app pipeline had
    // not been held to it. An OFFLINE context at the file's own rate (from
    // its header) makes the decode bit-exact for lossless files and never
    // touches an audio device. When the rate can't be read, or the context
    // refuses it, the decode still runs for the picture — but the DR is
    // WITHHELD: a citation is never approximated.
    const rate = sniffSampleRate(u8);
    let ctx: OfflineAudioContext;
    let native = false;
    try {
      ctx = new OfflineAudioContext(1, 1, rate ?? 48000);
      native = rate != null;
    } catch {
      ctx = new OfflineAudioContext(1, 1, 48000);
    }
    try {
      // the decode takes (and detaches) the whole buffer; a view onto part of one is copied out
      const whole = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength;
      const audio = await ctx.decodeAudioData(
        whole ? (u8.buffer as ArrayBuffer) : u8.slice().buffer,
      );
      const chans: Float32Array[] = [];
      for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
      // the arithmetic (peaks, envelopes, DR, R128, the scenes' strip, onsets and
      // features) runs in the analysis worker; the channel buffers go over transferred
      const analysis: Analysis = await measureOffThread(
        chans,
        audio.sampleRate,
        native,
        CAPTURE_BUCKETS,
      );
      // (main records the album this track completes, if it does, and every window hears it)
      if (contentKey) void tt.audioAnalysisPut(contentKey, toStored(analysis));
      return analysis;
    } catch {
      return null;
    }
  })();
  // every caller gets null for a stopped measuring; the cache forgets it
  const settled = p.catch(() => null);
  cache.set(key, settled);
  void p.then(
    (a) => {
      if (a != null) return;
      cache.delete(key);
      failedAt.set(key, Date.now());
    },
    // a skipped track's measuring (cancelled) is no failure: its next play measures it
    () => cache.delete(key),
  );
  return settled;
}

export function usePeaks(
  serverUdn: string | null,
  objectId: string | null,
  contentKey: string | null = null,
): Analysis | null | "loading" {
  const [state, setState] = useState<Analysis | null | "loading">("loading");
  // while the file is measured in pieces, what is measured so far (0.14.0)
  const key = serverUdn && objectId ? `${serverUdn}|${objectId}` : null;
  const partial = useLivePartial(state === "loading" ? key : null);
  const attempt = useSyncExternalStore(subscribeLive, () => (key ? (retries.get(key) ?? 0) : 0));
  useEffect(() => {
    if (!serverUdn || !objectId) {
      setState(null);
      return;
    }
    let stale = false;
    setState("loading");
    void analyzeTrack(serverUdn, objectId, contentKey).then((a) => {
      if (!stale) setState(a);
    });
    return () => {
      stale = true;
    };
  }, [serverUdn, objectId, contentKey, attempt]);
  return state === "loading" && partial ? partial : state;
}

/** The playing track's library identity, resolved by content — for surfaces
 *  (display mode) that don't already hold the Stream tab's enriched node. */
export function usePlayingFileRef(): {
  serverUdn: string;
  objectId: string;
  contentKey: string;
} | null {
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const [ref, setRef] = useState<{
    serverUdn: string;
    objectId: string;
    contentKey: string;
  } | null>(null);
  const md = playState?.metadata;
  const trackKey = `${md?.title ?? ""}|${md?.artist ?? ""}|${md?.album ?? ""}`;
  const psRef = useRef(playState);
  psRef.current = playState;
  const npRef = useRef(nowPlaying);
  npRef.current = nowPlaying;
  // AFTER A REBUILD (the seek bar's waveform used to wait for the next
  // track): an index that is building answers no lookup, so a track that started then asks
  // again once the ready indexes change; a file already found for this track is kept
  const readySig = useReadyIndexSig();
  const heldFor = useRef<string | null>(null);
  useEffect(() => {
    if (heldFor.current === trackKey) return;
    heldFor.current = null;
    let stale = false;
    setRef(null);
    const built = nowPlayingInfoTarget(psRef.current, npRef.current);
    if (!built?.localQuery) return;
    // a show: this runs on every track change, and must never rebuild the index
    void tt
      .mediaNodeInfo(built.localQuery, "show")
      .then((found) => {
        if (stale || !found?.node.serverUdn || !found.node.id) return;
        heldFor.current = trackKey;
        setRef({
          serverUdn: found.node.serverUdn,
          objectId: found.node.id,
          contentKey: audioAnalysisKey(found.node),
        });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [trackKey, readySig]);
  return ref;
}

/** The playing track's analysis for display mode's scenes: resolved by
 *  content like the strip below, measured on first play when it isn't cached
 *  (the decode is the same one the waveform needs). Null for radio, casts and
 *  tracks no library knows; nothing is fetched while `enabled` is false. */
export function usePlayingAnalysis(enabled: boolean): Analysis | null | "loading" {
  const ref = usePlayingFileRef();
  return usePeaks(
    enabled ? (ref?.serverUdn ?? null) : null,
    ref?.objectId ?? null,
    ref?.contentKey ?? null,
  );
}

/** A cache-only look — the in-memory promise, then the disk store — never a
 *  fetch. undefined = known nowhere (the Info modal offers Analyze instead). */
async function peekAnalysis(
  serverUdn: string,
  objectId: string,
  contentKey: string,
): Promise<Analysis | null | undefined> {
  const key = `${serverUdn}|${objectId}`;
  const hit = cache.get(key);
  // a file whose server stopped sending says so, with Try again, rather than offering Analyze
  const found = stalled.get(key)
    ? null
    : hit
      ? await hit
      : await tt.audioAnalysisGet(contentKey).then((s) => (s ? fromStored(s) : undefined));
  peeked.set(`${serverUdn}|${objectId}`, { found });
  return found;
}

// What a peek last found, by location, read synchronously: a step in the Info modal looks the
// next track's analysis up BEFORE it swaps (warmAnalysis, through lib/infoSteps), so the new track
// renders whole in one frame instead of passing through "loading" (0.12.0: the waveform, the DR
// and LUFS chips and the Format rows flashed out and back on every step)
const peeked = new Lru<string, { found: Analysis | null | undefined }>(200);

/** Looks a track's analysis up ahead of showing it (memory, then disk; never a decode). */
export async function warmAnalysis(
  serverUdn: string,
  objectId: string,
  contentKey: string,
): Promise<void> {
  await peekAnalysis(serverUdn, objectId, contentKey);
}

const knownNow = (serverUdn: string | null, objectId: string): KnownAnalysis | null => {
  const hit = serverUdn ? peeked.get(`${serverUdn}|${objectId}`) : undefined;
  return hit ? (hit.found === undefined ? "unknown" : hit.found) : null;
};

export type KnownAnalysis = Analysis | null | "loading" | "unknown";

/**
 * The Info modal's analysis state, lifted out of the picture so the header's
 * DR chip and the waveform read ONE state: a cache-only peek on mount
 * (memory, then disk — a metadata modal never fetches and decodes a track
 * for being opened), and an explicit analyze() for the button. `available`
 * is false when waveforms are off or the node has no server — render nothing.
 */
export function useKnownAnalysis(
  serverUdn: string | null,
  objectId: string,
  contentKey: string,
): { available: boolean; state: KnownAnalysis; partial: Analysis | null; analyze(): void } {
  const enabled = useStore((s) => s.settings.waveforms);
  const [state, setState] = useState<KnownAnalysis>(
    () => knownNow(serverUdn, objectId) ?? "loading",
  );
  // while Analyze measures the file in pieces, what is measured so far (0.14.0)
  const partial = useLivePartial(
    enabled && serverUdn && state === "loading" ? `${serverUdn}|${objectId}` : null,
  );
  useEffect(() => {
    if (!enabled || !serverUdn) return;
    let stale = false;
    // what a step already looked up shows at once; the peek still runs, to catch a newer answer
    setState(knownNow(serverUdn, objectId) ?? "loading");
    void peekAnalysis(serverUdn, objectId, contentKey).then((a) => {
      if (!stale) setState(a === undefined ? "unknown" : a);
    });
    return () => {
      stale = true;
    };
  }, [enabled, serverUdn, objectId, contentKey]);
  const analyze = (): void => {
    if (!serverUdn) return;
    setState("loading");
    void analyzeTrack(serverUdn, objectId, contentKey, { keep: true }).then((a) => setState(a));
  };
  // Info open on a track keeps its measuring going through a skip (0.14.0)
  useEffect(
    () => (enabled && serverUdn ? holdAnalysis(serverUdn, objectId) : undefined),
    [enabled, serverUdn, objectId],
  );
  return { available: enabled && serverUdn != null, state, partial, analyze };
}

/** The playing track's DR, or null until its analysis lands — live, not from
 *  the settled snapshot: the analysis arrives seconds after the track does. */
export function usePlayingDr(): number | null {
  const enabled = useStore((s) => s.settings.waveforms);
  const ref = usePlayingFileRef();
  const analysis = usePeaks(
    enabled ? (ref?.serverUdn ?? null) : null,
    ref?.objectId ?? null,
    ref?.contentKey ?? null,
  );
  return analysis != null && analysis !== "loading" && analysis.dr > 0 ? analysis.dr : null;
}

/** The playing track's loudness facts for the Info surfaces (null until measured). */
export function usePlayingLoudness(): {
  lufs: number | null;
  truePeakDb: number | null;
  lra: number | null;
} | null {
  const enabled = useStore((s) => s.settings.waveforms);
  const ref = usePlayingFileRef();
  const analysis = usePeaks(
    enabled ? (ref?.serverUdn ?? null) : null,
    ref?.objectId ?? null,
    ref?.contentKey ?? null,
  );
  return analysis != null && analysis !== "loading" && analysis.lufs != null
    ? { lufs: analysis.lufs, truePeakDb: analysis.truePeakDb, lra: analysis.lra }
    : null;
}

/** The playing track's tempo and key for the Stream tab's rows (shared/model's words). */
export function usePlayingMeasured(): { tempo: number | null; key: string | null } | null {
  const enabled = useStore((s) => s.settings.waveforms);
  const ref = usePlayingFileRef();
  const analysis = usePeaks(
    enabled ? (ref?.serverUdn ?? null) : null,
    ref?.objectId ?? null,
    ref?.contentKey ?? null,
  );
  const f = analysis != null && analysis !== "loading" ? analysis.features : null;
  return f ? { tempo: tempoBpm(f.beats), key: keyName(f.key) } : null;
}

/**
 * A SKIP STOPS THE SKIPPED TRACK'S MEASURING (0.14.0): when the
 * playing file changes, the last one's measuring stops, with its download, unless it played to
 * its end (within END_SLACK_S of it: then the little left of the download finishes under the next
 * track), or something holds it (Info open on it, an Analyze audio sweep). Mounted once, in App.
 */
const END_SLACK_S = 5;
export function useStopSkippedAnalysis(): void {
  const ref = usePlayingFileRef();
  const playhead = useStore((s) => s.playhead);
  const md = useStore((s) => s.playState?.metadata);
  const duration = md?.duration ?? null;
  const track = `${md?.title ?? ""}|${md?.artist ?? ""}|${md?.album ?? ""}`;
  const seen = useRef<{
    key: string;
    track: string;
    serverUdn: string;
    objectId: string;
    secs: number;
    duration: number | null;
  } | null>(null);
  // after every render: a change of file is checked against where the last one had got to, then
  // where this one is now is kept for the next change
  useEffect(() => {
    const key = ref ? `${ref.serverUdn}|${ref.objectId}` : null;
    const prev = seen.current;
    if (prev && prev.key !== key) {
      const ended =
        prev.duration != null && prev.duration > 0 && prev.secs >= prev.duration - END_SLACK_S;
      if (!ended) stopAnalysis(prev.serverUdn, prev.objectId);
    }
    // between a track change and the next file's lookup, the playhead is the next track's: the
    // last file keeps where it had got to (a track played to its end isn't taken for a skip)
    if (prev && prev.key === key && prev.track !== track) return;
    seen.current =
      ref && key
        ? {
            key,
            track,
            serverUdn: ref.serverUdn,
            objectId: ref.objectId,
            secs: playhead?.secs ?? 0,
            duration,
          }
        : null;
  });
}
