import { useState } from "react";
import { useStore } from "@/store";
import { SIGNAL_COLORS, SIGNAL_LABELS, cx, fmtKHz, signalGlow, signalQuality } from "@/lib/format";
import type { SignalQuality } from "@/lib/format";
import { PopoverCard } from "@/components/chrome/Overlay";

/** The signal lamp's three colors and what each means, shown in the lamp's own popover. */
const SIGNAL_LEGEND: [Exclude<SignalQuality, "unknown">, string, string][] = [
  ["hires", "Hi-res lossless", "Lossless above CD quality (or MQA)."],
  ["lossless", "Lossless", "Bit-perfect CD quality."],
  ["lossy", "Lossy", "Compressed stream (internet radio, Bluetooth, AAC/MP3)."],
];

/**
 * The lamp glyph. Colour AND shape say the quality, so the lamp reads without
 * hue (a colour-vision request, 2026-08-21 — amber vs green was one lamp to
 * red-green colour-blind eyes): hi-res is a lit dot inside a halo ring,
 * lossless a lit dot, lossy an unlit ring. ONE definition — the bar, Now
 * Playing, the tray panel, the popover header and the Settings legend all
 * draw this; nothing else may paint a signal colour on its own.
 */
export function SignalDot({
  quality,
  className = "h-2.5 w-2.5",
}: {
  quality: SignalQuality;
  className?: string;
}): React.JSX.Element {
  const color = SIGNAL_COLORS[quality];
  const style: React.CSSProperties =
    quality === "hires"
      ? {
          background: color,
          boxShadow: signalGlow(color),
          outline: `1.5px solid ${color}`,
          outlineOffset: "2px",
        }
      : quality === "lossy"
        ? { boxShadow: `inset 0 0 0 2px ${color}` }
        : { background: color, boxShadow: signalGlow(color) };
  return (
    <span data-signal={quality} className={cx("block rounded-full", className)} style={style} />
  );
}

/**
 * Roon-style signal light: one glance says how good the stream is; a click shows
 * the whole chain the streamer reports. Colors are fixed (not the art accent) so
 * quality always reads the same.
 */
export function SignalLamp({
  /**
   * Tooltip placement. Defaults to the playback bar's "above, centred", which
   * is wrong anywhere the lamp isn't in the middle of a wide bar: in the tray
   * panel it sits ~14px from the left of a 380px window, where a centred tip
   * starts off-screen.
   */
  tipClass = "tip-top",
}: { tipClass?: string } = {}): React.JSX.Element | null {
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  // Click point, not a boolean: the detail card is a PopoverCard, which
  // portals and CLAMPS itself on-screen from where you clicked.
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  const quality = signalQuality(playState);
  if (quality === "unknown") return null;

  const md = playState?.metadata;
  const color = SIGNAL_COLORS[quality];

  const rows: Array<[string, string]> = [];
  if (nowPlaying?.source?.name) rows.push(["Source", nowPlaying.source.name]);
  if (md?.codec) rows.push(["Codec", md.codec]);
  if (md?.sample_rate) rows.push(["Sample rate", fmtKHz(md.sample_rate)]);
  if (md?.bit_depth) rows.push(["Bit depth", `${md.bit_depth}-bit`]);
  if (md?.bitrate) rows.push(["Bitrate", `${Math.round(md.bitrate / 1000)} kbps`]);
  rows.push(["Lossless", md?.lossless ? "yes" : "no"]);
  if (md?.mqa && md.mqa !== "none") rows.push(["MQA", md.mqa]);

  return (
    <div className="relative">
      <button
        data-tip={at ? undefined : `Signal: ${SIGNAL_LABELS[quality]}`}
        aria-label={`Signal: ${SIGNAL_LABELS[quality]}`}
        onClick={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          setAt((o) => (o ? null : { x: b.left, y: b.bottom + 6 }));
        }}
        className={cx(tipClass, "p-2 rounded-md hover:bg-veil transition-colors")}
      >
        <SignalDot quality={quality} />
      </button>

      {/* THE SHELL, not a hand-rolled box. This used to be an `absolute
          bottom-11 right-0` div, which assumed the lamp sits at the RIGHT of a
          wide bar — true in the playback bar, false in the tray panel, where
          the same markup opened up and to the left, off two edges of a 380px
          window at once. PopoverCard portals, backdrops and clamps, which is
          what the chrome kit exists for. */}
      {at && (
        <PopoverCard at={at} width="w-60" onClose={() => setAt(null)} className="p-3">
          <div className="flex items-center gap-2 mb-2.5">
            <SignalDot quality={quality} className="h-2 w-2" />
            <span className={cx("microlabel")} style={{ color }}>
              {SIGNAL_LABELS[quality]}
            </span>
          </div>
          <div className="space-y-1.5">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] text-faint">{label}</span>
                <span className="font-mono text-[11px] text-ink/90">{value}</span>
              </div>
            ))}
          </div>
          {/* what each color means, beside the lamp it describes (0.16.0's settings diet: the
              legend had a Settings tab of its own); this one's own color reads in ink */}
          <div data-signal-legend className="mt-3 pt-2.5 border-t border-edge space-y-1.5">
            {SIGNAL_LEGEND.map(([q, label, desc]) => (
              <div
                key={q}
                className={cx(
                  "flex items-start gap-2 text-[11px] leading-snug",
                  q === quality ? "text-ink" : "text-faint",
                )}
              >
                <SignalDot quality={q} className="h-1.5 w-1.5 mt-[5px] shrink-0" />
                <span>
                  <span className="font-medium">{label}</span> {desc}
                </span>
              </div>
            ))}
          </div>
        </PopoverCard>
      )}
    </div>
  );
}
