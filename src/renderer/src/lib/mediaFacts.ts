import {
  albumFormat,
  fmtBytes,
  LOSSLESS_CODECS,
  type MediaFormat,
  type MediaNode,
} from "@shared/model";
import { fmtKHz, fmtTime } from "@/lib/format";

/**
 * TWO REGISTERS, split by KIND OF FACT (user call, 2026-09-01):
 *  - TECHNICAL FORMAT TOKENS — codec, rate/depth, bitrate, lossless, DR —
 *    are `.badge` CHIPS wherever they appear, live (Now Playing's row) or at
 *    rest (the Library album header, both Info modal headers).
 *  - COLLECTION FACTS — year, track count, runtime, size — are PROSE: the
 *    dotted faint facts line. A count or a duration never wears a chip.
 * One home for both builders, so the Library header and the album Info
 * modal can never drift.
 */

/** The facts line's separator: EN spaces around the dot, so the items
 *  breathe (user, 2026-09-01) — plain double spaces would collapse in HTML. */
export const FACT_SEP = "\u2002·\u2002";

/** "2023 · 10 tracks · 26:53 · 200 MB" — collection facts only; the format
 *  rides beside it as chips (albumFormatChips). */
export function albumFactsLine(
  album: Pick<MediaNode, "year">,
  tracks: ReadonlyArray<Pick<MediaNode, "year" | "durationSecs" | "format">>,
): string {
  const secs = tracks.reduce((a, t) => a + (t.durationSecs ?? 0), 0);
  const bytes = tracks.reduce((a, t) => a + (t.format?.sizeBytes ?? 0), 0);
  return [
    album.year ?? tracks[0]?.year ?? null,
    tracks.length > 0 ? `${tracks.length} tracks` : null,
    secs > 0 ? fmtTime(secs) : null,
    bytes > 0 ? fmtBytes(bytes) : null,
  ]
    .filter(Boolean)
    .join(FACT_SEP);
}

/** A track's collection facts — its duration. */
export function trackFactsLine(node: Pick<MediaNode, "durationSecs">): string {
  return node.durationSecs ? fmtTime(node.durationSecs) : "";
}

/** The format tokens as Now Playing's chip row spells them — codec · kHz ·
 *  bit depth · kbps · lossless — from the server's description of the file,
 *  so a track at rest wears the same chips it will wear playing. */
export function formatChips(f: MediaFormat | undefined | null): string[] {
  if (!f) return [];
  const out: string[] = [];
  if (f.codec) out.push(f.codec);
  if (f.rate) out.push(fmtKHz(f.rate));
  if (f.bits) out.push(`${f.bits}-bit`);
  if (f.kbps) out.push(`${f.kbps} kbps`);
  if (f.codec && LOSSLESS_CODECS.has(f.codec.toUpperCase())) out.push("lossless");
  return out;
}

/** An album's format tokens: "FLAC · 16/44.1" split into chips, or the one
 *  honest "mixed formats" chip when the tracks disagree. */
export function albumFormatChips(tracks: ReadonlyArray<Pick<MediaNode, "format">>): string[] {
  const label = albumFormat(tracks).label;
  return label ? label.split(" · ").filter(Boolean) : [];
}
