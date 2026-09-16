import { albumOfTrack, type MediaIndexPools, type MediaNode } from "@shared/model";
import { focusArtistsLens } from "@/components/library/LibraryLenses";
import type { Crumb } from "@/screens/LibraryScreen";

// The Library's lens navigation, lifted out of LibraryScreen (2026-09-10, the
// landOn hygiene round): entering and leaving the three lenses, the albums and
// artists their rows lead to, and THE ONE LANDING every arrival goes through.

/** The three lenses over the union of ready indexes, and their crumb/door
 *  labels — one home for the label (the crumb and the album leaf's way-back
 *  crumb both read it). */
export type Lens = "albums" | "artists" | "tracks";
export const LENS_LABEL: Record<Lens, string> = {
  albums: "Albums",
  artists: "Artists",
  tracks: "Tracks",
};

// Synthetic crumb planted when a LENS result is opened: the trail reads
// Library › server › Albums › <album>, and the lens crumb (or Backspace)
// restores the lens exactly as it was left. Same contract as the search
// crumb; titlePaths strip it the same way.
export const LENS_CRUMB_ID = "__lens__";
/** The artist between the Artists lens crumb and an album opened from it —
 *  the trail says the path you took; clicking it returns to the lens focused
 *  on that artist (2026-09-01: "minitunes > Artists > <album>" read as a
 *  hierarchy that doesn't exist and lost the one node connecting them). */
export const LENS_ARTIST_CRUMB_ID = "__lens-artist__";

// Which lens the crumb leads back to (module scope — survives the scoped
// album detour, like the lens components' own selection memories).
let lensReturnTo: Lens | null = null;
/** A history restore hands a lens back: the crumb returns to it. */
export const setLensReturn = (lens: Lens): void => {
  lensReturnTo = lens;
};

/**
 * Where an arrival lands. An ARTIST: the Artists lens at the root, focused and
 * revealed on them. An ALBUM: its trail, the track to land on (scrolled to and
 * washed once its listing arrives), the lens its crumb returns to, and a crumb
 * that leads the trail off this screen (the unified search's way back).
 */
export type Landing =
  | { artist: string }
  | { udn: string | null; path: Crumb[]; track?: string | null; returnTo?: Lens; lead?: Crumb };

export function lensNavigation(d: {
  lens: Lens | null;
  setLens(lens: Lens | null): void;
  atRoot: boolean;
  searchMode: boolean;
  serverUdn: string | null;
  lensPools: MediaIndexPools[] | null;
  /** True while an arrival or a history restore runs: those never record. */
  restoring: { current: boolean };
  pendingTrack: { current: string | null };
  /** Record the spot being left (skipped while restoring). */
  pushSpot(): void;
  moveTo(udn: string | null, path: Crumb[]): void;
  setPath(update: (path: Crumb[]) => Crumb[]): void;
  showNotice(msg: string): void;
}) {
  const openLens = (which: Lens): void => {
    d.pushSpot();
    lensReturnTo = which;
    d.setLens(which);
  };

  /** THE ONE LANDING (filed 2026-09-02, folded 2026-09-10). An arrival from
   *  another screen (a LibraryTarget) and a link inside the Library (the Tracks
   *  lens's names and Go-to verbs, the album rows' and the header's artist)
   *  decide here, once, the crumbs, the lens the crumb returns to and the track
   *  to land on. The landing used to be a side effect each caller remembered,
   *  and the Tracks lens once forgot it. */
  const landOn = (to: Landing): void => {
    if ("artist" in to) {
      focusArtistsLens(to.artist);
      // a link at the root outside search is a lens switch (openLens records
      // it); an arrival, or a link from a folder or a search, re-seats the root
      // first (moveTo's one history entry, none while arriving)
      if (!d.restoring.current && d.atRoot && !d.searchMode) return openLens("artists");
      d.moveTo(null, []);
      lensReturnTo = "artists";
      d.setLens("artists");
      return;
    }
    if (to.returnTo) lensReturnTo = to.returnTo;
    d.pendingTrack.current = to.track ?? null;
    d.moveTo(to.udn, to.path);
    const lead = to.lead;
    if (lead) d.setPath((p) => [lead, ...p]);
  };

  /** A lens result opens the SHARED native album leaf, scoped to its server;
   *  the lens crumb offers the way back with the lens state intact. */
  const openAlbumFromLens = (node: MediaNode, track?: string): void => {
    if (!node.serverUdn || !d.lens) return;
    // a track's album (the Tracks lens's link or Go to album): land on THE
    // TRACK, scrolled to and washed, exactly as the Queue's link does through
    // openRefInLibrary — one gesture, one landing (user, 2026-09-02). From the
    // Artists lens the artist rides between the lens crumb and the album — the
    // trail says the path you took, and the crumb is the way back to the lens
    // focused on them
    const via =
      d.lens === "artists" && node.artist ? [{ id: LENS_ARTIST_CRUMB_ID, title: node.artist }] : [];
    landOn({
      udn: node.serverUdn,
      path: [
        { id: LENS_CRUMB_ID, title: LENS_LABEL[d.lens] },
        ...via,
        { id: node.id, title: node.title, node },
      ],
      track: track ?? null,
      returnTo: d.lens,
    });
  };

  const returnToLens = (): void => {
    d.moveTo(null, []);
    d.setLens(lensReturnTo);
  };

  /** The Tracks lens's links (and its menu's Go-to verbs): the album by
   *  content identity in the same server's pool — no network — entered
   *  through the lens crumb so Back returns to the lens; the artist as the
   *  Artists lens, focused on them (a lens switch, so Back returns too). */
  const goToAlbumFromLens = (track: MediaNode): void => {
    const pool = d.lensPools?.find((g) => g.udn === (track.serverUdn ?? d.serverUdn));
    const album = pool ? albumOfTrack(track, pool) : null;
    if (!album) {
      d.showNotice(`Couldn't find "${track.album ?? "that album"}" in this library.`);
      return;
    }
    openAlbumFromLens(album, track.title);
  };
  const goToArtistFromLens = (node: MediaNode): void => {
    if (node.artist) landOn({ artist: node.artist });
  };

  return {
    openLens,
    landOn,
    openAlbumFromLens,
    returnToLens,
    goToAlbumFromLens,
    goToArtistFromLens,
  };
}
