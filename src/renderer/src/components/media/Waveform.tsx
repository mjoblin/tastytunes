import { useEffect, useRef, useState } from "react";
import { tt } from "@/api";

/**
 * EXPERIMENT (0.7 exploration, the audio-file-data GO): the playing track's
 * waveform, drawn from the actual file. Main fetches the bytes from the
 * LOCAL media server; this component decodes them with WebAudio and draws
 * peak bars. Everything is best-effort and silent on failure — an absent
 * waveform is an absent row, never an error. Peaks are cached per object id
 * for the session so tab flips don't refetch megabytes.
 */

const BUCKETS = 240;
const peaksCache = new Map<string, Float32Array>();

async function loadPeaks(serverUdn: string, objectId: string): Promise<Float32Array | null> {
  const key = `${serverUdn}|${objectId}`;
  const hit = peaksCache.get(key);
  if (hit) return hit;
  const bytes = await tt.expTrackAudio(serverUdn, objectId);
  if (!bytes) return null;
  // The IPC hands a Uint8Array view; decodeAudioData wants its own buffer.
  const u8 = new Uint8Array(bytes);
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(u8.slice().buffer);
    const data = audio.getChannelData(0);
    const peaks = new Float32Array(BUCKETS);
    const per = Math.max(1, Math.floor(data.length / BUCKETS));
    for (let b = 0; b < BUCKETS; b++) {
      let max = 0;
      const start = b * per;
      const end = Math.min(start + per, data.length);
      // Sample within the bucket rather than touching every frame — a 40M
      // frame track would otherwise cost real main-thread time.
      const step = Math.max(1, Math.floor((end - start) / 400));
      for (let i = start; i < end; i += step) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
      peaks[b] = max;
    }
    peaksCache.set(key, peaks);
    return peaks;
  } catch {
    return null;
  } finally {
    void ctx.close();
  }
}

export function Waveform({
  serverUdn,
  objectId,
}: {
  serverUdn: string;
  objectId: string;
}): React.JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stale = false;
    setPeaks(null);
    setFailed(false);
    void loadPeaks(serverUdn, objectId).then((p) => {
      if (stale) return;
      if (p) setPeaks(p);
      else setFailed(true);
    });
    return () => {
      stale = true;
    };
  }, [serverUdn, objectId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const gold =
      getComputedStyle(document.documentElement).getPropertyValue("--gold").trim() || "#d3a13c";
    ctx.fillStyle = gold;
    ctx.globalAlpha = 0.75;
    const barW = w / peaks.length;
    const mid = h / 2;
    for (let i = 0; i < peaks.length; i++) {
      const half = Math.max(0.5, peaks[i] * mid);
      ctx.fillRect(i * barW, mid - half, Math.max(0.5, barW - 0.75), half * 2);
    }
  }, [peaks]);

  if (failed) return null;
  return (
    <div data-waveform className="pt-1">
      <div className="microlabel mb-1.5">waveform</div>
      {peaks ? (
        <canvas ref={canvasRef} className="w-full h-12 block" />
      ) : (
        <div className="h-12 flex items-center text-[11.5px] text-faint motion-safe:animate-pulse">
          Reading the file…
        </div>
      )}
    </div>
  );
}
