// THE LIBRARY'S PLACES, lifted out of LibraryScreen (0.15.0, the screen's split, its hooks first):
// the crumb, the per-level scroll and filter memories, the synthetic crumbs a search plants, and
// the stand-in an arrival builds, which the screen, its navigation (useLibraryNavigation) and its
// other hooks share.
import type { MediaNode } from "@shared/model";
import { Lru } from "@/lib/lru";

// Crumbs keep the entered node so an album level can render its header
// (art, artist, year) without re-fetching metadata.
export type Crumb = { id: string; title: string; node?: MediaNode };

// Returning to the Library RESTORES where the last visit left off
// (positionMemory below) — the old "always the front door" rule was reversed;
// the reset now lives behind re-invoking Library while already here, or the
// breadcrumb root. Per-folder scroll and filter memories apply while browsing
// within a visit.
export const scrollMemory = new Map<string, number>();
// Per-LEVEL filter memory: each folder keeps its own filter for the session
// (the store's screenFilters.library always holds the current level's).
export const filterMemory = new Map<string, string>();
// Where the last visit left off — server, crumb trail, and which lens was open —
// is the store's libraryLocation (the 0.11.0 sweep; it was a module variable here
// and a second copy in lib/navSpot for history). The screen UNMOUNTS on every
// navigation away (App renders only the active screen), so component state can't
// survive the trip. Restored on arrival from another screen; deliberately NOT
// consulted when the front door is asked for explicitly (see the reset effect).

export const nodeKey = (serverUdn: string | null, path: Crumb[]): string =>
  `${serverUdn ?? ""}|${path.map((c) => c.id).join("/")}`;

// Synthetic crumb planted when a search RESULT is entered: the trail reads
// Library › server › “query” › Artist, and the query crumb (or Backspace)
// restores the search with its results intact. It never reaches the browse
// layer — titlePaths strip it (a result's true folder path is unknown, so
// stale-id rewalks can't recover search-entered branches either way).
export const SEARCH_CRUMB_ID = "__search-results__";

// The lens crumbs (LENS_CRUMB_ID, LENS_ARTIST_CRUMB_ID) live with the lens
// navigation in components/library/lensNavigation.
/**
 * Planted when a UNIFIED SEARCH result opens here: the trail reads
 * Search › <server> › <album>, and that crumb — or Backspace, or ⌘← — returns
 * to the Search screen with its query intact (the screen remembers it).
 *
 * Same idiom as the search and lens crumbs, with one difference worth stating: this crumb
 * leads OFF this screen. Without it, arriving from search left you in a browse
 * tree you never navigated into, and back went to the source list (⌘← led to
 * the top of the library).
 */
export const UNIFIED_SEARCH_CRUMB_ID = "__from-search__";
/** Each artist page's scroll spot for the session (an album opened from it and Back). */
export const artistPageScroll = new Lru<string, number>(200);
/** The stand-in album nodes an arrival builds (the arrival effect): an album opened from another
 *  screen lands on one, and resolves to the index's own entry once the pools are in. */
export const standIns = new WeakSet<MediaNode>();
/** Marks an arrival's stand-in album node (see standIns). */
export function standIn(node: MediaNode): MediaNode {
  standIns.add(node);
  return node;
}
