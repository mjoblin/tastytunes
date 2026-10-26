import { albumFormat, formatLabel, type MediaFormat, type MediaNode } from "@shared/model";
import { fileQuality, type SignalQuality } from "@/lib/format";

/** formatLabel's dot with THIN spaces (his note on "Card details", 2026-10-26: the gap either side
 *  of the dot in "FLAC · 24/96" read large): the card's line is small text, and a word space each
 *  side of the dot split one fact in two. */
const TIGHT_SEP = " · ";

/** What an album card's format line says (0.13.0-rc.4, his picks on "Card details"). */
export interface CardFormat {
  /** The status lamp's quality for the album's format: null when unknown or mixed. */
  quality: SignalQuality | null;
  /** "FLAC · 24/96", tight; "mixed formats"; null when no track says. */
  label: string | null;
  /** The format in words, for the line's tip: "FLAC, 24-bit, 96 kHz, hi-res". */
  tip: string | null;
}

/** "5.1" for six channels, "7.1" for eight, "4 ch" for other surround; null for stereo or mono. */
function channelsOf(f: MediaFormat): string | null {
  if (!f.channels || f.channels <= 2) return null;
  return f.channels === 6 ? "5.1" : f.channels === 8 ? "7.1" : `${f.channels} ch`;
}

/** A format in words: "FLAC, 24-bit, 96 kHz", "MP3, 320 kbps", what is known. */
function wordsOf(f: MediaFormat): string {
  const khz = f.rate ? `${(f.rate / 1000).toFixed(f.rate % 1000 === 0 ? 0 : 1)} kHz` : null;
  const parts =
    fileQuality(f) === "lossy"
      ? [f.codec, f.kbps ? `${f.kbps} kbps` : null]
      : [f.codec, f.bits ? `${f.bits}-bit` : null, khz];
  if (f.channels && f.channels > 2) parts.push(`${f.channels} channels`);
  return parts.filter(Boolean).join(", ");
}

/**
 * AN ALBUM CARD'S FORMAT (0.13.0-rc.4): the format its tracks share, or most of them (albumFormat,
 * the one rule the album header reads too), with the lamp's quality for it; "mixed formats" when
 * no format holds half of them, its tip naming each. Surround joins the line ("5.1") only when an
 * album has it.
 */
export function cardFormat(tracks: ReadonlyArray<Pick<MediaNode, "format">>): CardFormat {
  const { label } = albumFormat(tracks);
  if (!label) return { quality: null, label: null, tip: null };
  const formats = tracks.map((t) => t.format).filter((f): f is MediaFormat => f != null);
  if (label === "mixed formats") {
    const counts = new Map<string, number>();
    for (const f of formats) {
      const l = formatLabel(f)?.replace(" · ", " ");
      if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    const named = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([l]) => l);
    const list =
      named.length > 1
        ? `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`
        : named[0];
    return { quality: null, label, tip: `Mixed formats: ${list}` };
  }
  const f = formats.find((x) => formatLabel(x) === label);
  if (!f) return { quality: null, label: null, tip: null };
  const quality = fileQuality(f);
  const ch = channelsOf(f);
  return {
    quality,
    label: [label.replace(" · ", TIGHT_SEP), ch].filter(Boolean).join(TIGHT_SEP),
    tip: `${wordsOf(f)}${quality === "hires" ? ", hi-res" : ""}`,
  };
}
