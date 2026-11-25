// THE SEARCH SCREEN'S SHARED PIECES (moved out of SearchScreen.tsx as they were, 0.16.0's tidy before
// the design pass's one Search with scopes): its constants, a result row's shape, what a library
// result is, and the session's memories, one object where three module variables were.
import type { MediaNode, RadioStation } from "@shared/model";
import { mediaKind, type MediaKind } from "@/lib/media";

/** Below this, a query matches half the library and every station on earth. */
export const MIN_RADIO_CHARS = 2;
/** A group's row as this screen builds it: the sort key the name sort reads,
 *  the kind the library's sub-headings section by, and the rendered row. */
export type SearchRow = { key: string; sortKey: string; kind?: MediaKind; node: React.ReactNode };

/** The library's partition, offered once the library is the screen. */
export type LibKind = "all" | "artists" | "albums" | "tracks";

/**
 * Only two sorts GENERALIZE across five heterogeneous groups.
 *
 * 'relevance' is each source's own ranking (the index's for library, most-
 * listened for the directory, recency for the local collections) and is the
 * neutral, non-reversible default — same contract as the library results chip.
 * Name is the one field every result has. Artist and year are library-shaped;
 * a playlist, a preset and a station have neither, and date-added is
 * favorites-shaped. Those sorts live on the owning screens, which have them.
 */
export const SEARCH_SORTS: Array<{
  value: "relevance" | "name";
  label: string;
  noReverse?: boolean;
}> = [
  { value: "relevance", label: "Relevance", noReverse: true },
  { value: "name", label: "Name" },
];

/**
 * The session's memories — module scope, like the library's scroll and
 * find-recall memories. `query` is the last query: coming back to Search
 * mid-thought should show what you were looking for, and this is never a
 * setting. `libKind` is the library partition, the same way (it reset to All on
 * every return). `results` are the RESULTS of the last query (2026-08-22): a
 * return used to re-run every search from scratch and the scroll could only
 * settle once the radio directory had answered again. Seeded on mount for the
 * same query; the effects still refresh in the background and swap in what
 * changed.
 */
export const searchMemory: {
  query: string;
  libKind: LibKind;
  results: {
    query: string;
    lib: MediaNode[];
    libTotal: number;
    radio: RadioStation[] | null;
  } | null;
} = { query: "", libKind: "all", results: null };
/*
 * The scope and the sort are PERSISTED view defaults (settings searchScope and
 * searchSort; the scope replaced the hidden categories in 0.16.0's one Search),
 * unlike the query above. The scope is Everything or one category at a time, and
 * a group's "+N more" chooses its category, a choice like any chip's.
 */

// WHAT a library result is — the ONE classifier (lib/media), shared with the
// Library's own results filter. The index returns artists, albums AND tracks,
// and until the kind was on the row the click contract read as arbitrary: a
// track played, an album navigated, and nothing said which was which.
export const nodeKind = (n: MediaNode): MediaKind => mediaKind(n.upnpClass, n.isContainer);
export const kindLabel = (k: MediaKind): string => k[0].toUpperCase() + k.slice(1);
