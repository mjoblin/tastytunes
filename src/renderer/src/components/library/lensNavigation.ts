import { albumOfTrack, trackArtists, type MediaIndexPools, type MediaNode } from "@shared/model";
import { focusArtistsLens } from "@/components/library/LibraryLenses";
import type { Crumb } from "@/screens/LibraryScreen";
import type { LandingTrack } from "@/components/library/landing";

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
 *  on that artist (2026-09-01: "<server> > Artists > <album>" read as a
 *  hierarchy that doesn't exist and lost the one node connecting them). */
export const LENS_ARTIST_CRUMB_ID = "__lens-artist__";
/** The artist PAGE between the Artists crumb and an album opened from it (2026-10-11): the
 *  crumb returns to the page, where LENS_ARTIST_CRUMB_ID returns to the lens's columns. */
export const ARTIST_PAGE_CRUMB_ID = "__artist-page__";

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
  /** An artist by name: their page (since 2026-10-11, every way to an artist). */
  | { artist: string }
  | {
      udn: string | null;
      path: Crumb[];
      track?: LandingTrack | null;
      returnTo?: Lens;
      lead?: Crumb;
    };

export function lensNavigation(d: {
  lens: Lens | null;
  setLens(lens: Lens | null): void;
  /** The artist page over the Artists lens, by name (null: the lens's columns). */
  artistPage: string | null;
  setArtistPage(name: string | null): void;
  atRoot: boolean;
  searchMode: boolean;
  serverUdn: string | null;
  lensPools: MediaIndexPools[] | null;
  /** True while an arrival or a history restore runs: those never record. */
  restoring: { current: boolean };
  pendingTrack: { current: LandingTrack | null };
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
    d.setArtistPage(null);
  };

  /** THE ARTIST PAGE (2026-10-11, the user: "we get to an album page from the albums lens.
   *  but we can't get to an artist page from the artist lens"): opened over the Artists lens,
   *  so its crumb trail reads Library › Artists › <artist>, the Artists crumb returns to the
   *  columns with the artist selected, and Back undoes it like any move. From a folder or a
   *  search the root is re-seated first (moveTo's one history entry). */
  /** The artist a name means: the name when the indexes know it, else the first of its packed
   *  performers they know (a featured track's "The Neon Collective; Ivy Lane"). */
  const knownArtist = (name: string): string => {
    const pools = d.lensPools ?? [];
    const knows = (n: string): boolean => {
      const k = n.trim().toLowerCase();
      return pools.some(
        (p) =>
          p.artists.some((a) => a.title.trim().toLowerCase() === k) ||
          p.albums.some((a) => (a.artist ?? "").trim().toLowerCase() === k) ||
          p.tracks.some((t) => trackArtists(t).some((x) => x.trim().toLowerCase() === k)),
      );
    };
    if (knows(name)) return name;
    return name.split(/\s*;\s*/).find((part) => part && knows(part)) ?? name;
  };
  const openArtistPage = (asked: string): void => {
    const name = knownArtist(asked);
    focusArtistsLens(name);
    lensReturnTo = "artists";
    // the root's lens switch records the spot; an arrival, a folder or a search re-seats the
    // root (moveTo's one history entry, none while arriving), as the artist landing does
    if (!d.restoring.current && d.atRoot && !d.searchMode) d.pushSpot();
    else d.moveTo(null, []);
    d.setLens("artists");
    d.setArtistPage(name);
  };
  /** Back from the page to the Artists lens's columns, the artist still selected. */
  const closeArtistPage = (): void => {
    d.pushSpot();
    d.setArtistPage(null);
  };

  /** THE ONE LANDING (filed 2026-09-02, folded 2026-09-10). An arrival from
   *  another screen (a LibraryTarget) and a link inside the Library (the Tracks
   *  lens's names and Go-to verbs, the album rows' and the header's artist)
   *  decide here, once, the crumbs, the lens the crumb returns to and the track
   *  to land on. The landing used to be a side effect each caller remembered,
   *  and the Tracks lens once forgot it. */
  const landOn = (to: Landing): void => {
    // AN ARTIST LANDS ON THEIR PAGE (user, 2026-10-11, "yes, build it": an album's name opens
    // the album, so an artist's opens the artist; the navigator is the page's Artists crumb,
    // the artist selected there). It used to land on the Artists lens focused on the name.
    if ("artist" in to) return openArtistPage(to.artist);
    if (to.returnTo) lensReturnTo = to.returnTo;
    d.pendingTrack.current = to.track ?? null;
    d.moveTo(to.udn, to.path);
    const lead = to.lead;
    if (lead) d.setPath((p) => [lead, ...p]);
  };

  /** A lens result opens the SHARED native album leaf, scoped to its server;
   *  the lens crumb offers the way back with the lens state intact. */
  const openAlbumFromLens = (node: MediaNode, track?: LandingTrack): void => {
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

  /** An album opened from the artist page: the trail is Library › Artists › <artist> ›
   *  <album>, the artist crumb returning to the page; from an Appears-on row, on the track. */
  const openAlbumFromArtistPage = (node: MediaNode, artist: string, track?: LandingTrack): void => {
    if (!node.serverUdn) return;
    landOn({
      udn: node.serverUdn,
      path: [
        { id: LENS_CRUMB_ID, title: LENS_LABEL.artists },
        { id: ARTIST_PAGE_CRUMB_ID, title: artist },
        { id: node.id, title: node.title, node },
      ],
      track: track ?? null,
      returnTo: "artists",
    });
  };
  /** The artist crumb of an album opened from the page: back to the page. */
  const returnToArtistPage = (name: string): void => {
    d.moveTo(null, []);
    lensReturnTo = "artists";
    focusArtistsLens(name);
    d.setLens("artists");
    d.setArtistPage(name);
  };

  /** The Tracks lens's links (and its menu's Go-to verbs): the album by
   *  content identity in the same server's pool — no network — entered
   *  through the lens crumb so Back returns to the lens; the artist's page
   *  (Back returns too). */
  const goToAlbumFromLens = (track: MediaNode): void => {
    const pool = d.lensPools?.find((g) => g.udn === (track.serverUdn ?? d.serverUdn));
    const album = pool ? albumOfTrack(track, pool) : null;
    if (!album) {
      d.showNotice(`Couldn't find "${track.album ?? "that album"}" in this library.`);
      return;
    }
    openAlbumFromLens(album, { title: track.title, id: track.id, secs: track.durationSecs });
  };
  const goToArtistFromLens = (node: MediaNode): void => {
    if (node.artist) landOn({ artist: node.artist });
  };

  return {
    openLens,
    landOn,
    openAlbumFromLens,
    returnToLens,
    openArtistPage,
    closeArtistPage,
    openAlbumFromArtistPage,
    returnToArtistPage,
    goToAlbumFromLens,
    goToArtistFromLens,
  };
}
