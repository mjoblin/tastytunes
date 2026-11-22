import type { MediaNode } from "@shared/model";
import { nameKey } from "@shared/keys";
import { mediaKind } from "@/lib/media";

/**
 * The tracks among search results in running order: each album's tracks together, by disc and
 * position, the albums in the order they first appear; everything else keeps its place. The
 * index lists a server's tracks by title, so an album's hits read "10, 2, 7, 1" without this.
 */
export function inRunningOrder(list: MediaNode[]): MediaNode[] {
  const albumOf = (n: MediaNode): string =>
    `${n.serverUdn ?? ""}|${nameKey(n.album ?? "")}|${nameKey(n.albumArtist ?? "")}`;
  const slots: number[] = [];
  const first = new Map<string, number>();
  list.forEach((n, i) => {
    // a track with no album keeps its place: there is no running order to put it in
    if (mediaKind(n.upnpClass, n.isContainer) !== "track" || !n.album) return;
    slots.push(i);
    const k = albumOf(n);
    if (!first.has(k)) first.set(k, first.size);
  });
  const pos = (n: MediaNode): number => n.trackNumber ?? Number.MAX_SAFE_INTEGER;
  const tracks = slots
    .map((i) => list[i])
    .sort(
      (a, b) =>
        (first.get(albumOf(a)) ?? 0) - (first.get(albumOf(b)) ?? 0) ||
        (a.discNumber ?? 0) - (b.discNumber ?? 0) ||
        pos(a) - pos(b),
    );
  const out = [...list];
  slots.forEach((slot, j) => {
    out[slot] = tracks[j];
  });
  return out;
}
