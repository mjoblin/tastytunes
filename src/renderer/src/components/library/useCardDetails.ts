import { useMemo } from "react";
import { albumDrKey, type MediaNode } from "@shared/model";
import { useStore } from "@/store";
import { useAlbumDr } from "@/lib/audioAnalysis";
import { cardFormat, type CardFormat } from "./cardFormat";
import { nodeKey } from "./lenses/lensShared";
import type { LensIndex } from "./lenses/useLensIndex";

/** What an album card's format line shows: its format, and its DR once measured. */
export interface CardDetails extends CardFormat {
  dr: number | null;
  lufs: number | null;
}

/** Each index's albums' formats, by nodeKey ("set:" before a set's), made on a card's first read. */
const formatsOf = new WeakMap<LensIndex, Map<string, CardFormat>>();

/**
 * THE FORMAT LINE FOR A SURFACE'S ALBUM CARDS (0.13.0-rc.4, his picks on "Card details": the
 * status lamp's glyph, the format, DR's badge), or null while Settings › Layout turns it off. Each
 * album's format comes from its own tracks (the lens index's tracksOf), made once per index, and
 * its DR from the album DR map once Audio analysis has measured it; a set of volumes reads every
 * volume's tracks and shows no single DR.
 */
export function useCardDetails(
  index: LensIndex | null,
): ((album: MediaNode, volumes?: readonly MediaNode[]) => CardDetails) | null {
  const on = useStore((s) => s.settings.albumCardFormat);
  const albumDr = useAlbumDr();
  return useMemo(() => {
    if (!on || !index) return null;
    let formats = formatsOf.get(index);
    if (!formats) formatsOf.set(index, (formats = new Map<string, CardFormat>()));
    return (album, volumes) => {
      const k = `${volumes ? "set:" : ""}${nodeKey(album)}`;
      let f = formats.get(k);
      if (!f) {
        f = cardFormat(volumes ? volumes.flatMap((v) => index.tracksOf(v)) : index.tracksOf(album));
        formats.set(k, f);
      }
      const dr = volumes ? null : (albumDr[albumDrKey(album)] ?? null);
      return { ...f, dr: dr?.dr ?? null, lufs: dr?.lufs ?? null };
    };
  }, [on, index, albumDr]);
}
