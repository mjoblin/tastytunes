import { useStore } from "@/store";
import { isFavorited, toggleFavorite } from "@/lib/favorites";
import { refToFavorite, type MediaRef } from "@/lib/mediaRef";
import { openInfoForRef } from "@/lib/mediaInfo";
import { artistChoiceNow, resetArtistPicture, type CoverOffer } from "@/lib/artistPictures";

/**
 * THE menu contents for a piece of media — what RowMenu did for the menu
 * SHELL, done for what's inside it.
 *
 * Every surface used to hand-write its own item list, which is why the same
 * track offered five verbs in the Library, three in Favorites and none in
 * Search. A surface now composes its menu from these builders plus its own
 * local verbs (`extra` — Remove from queue, Remove from playlist…), so a
 * track's menu is the same menu everywhere BY CONSTRUCTION, and a future verb
 * added here lands on every screen at once.
 *
 * Universal verbs live inside the builders: the HEART (derived from the live
 * favorites list via content identity; `heart` cap overrides for surfaces
 * that store richer favorites, e.g. the Library's titlePath), the SEARCH
 * PIVOT (artists pivot on their own name, albums/tracks on their artist) and
 * an artist's PICTURE verbs (artistPictureItems).
 * Surface-dependent verbs arrive as capabilities and are simply omitted when
 * a surface can't offer them.
 */
export interface MediaMenuItem {
  label: string;
  run(): void;
  /** Shown but inert, with the reason as a hint line under the label (never
   *  a hover tooltip: a disabled control swallows the pointer). */
  disabled?: boolean;
  hint?: string;
}

export interface MediaMenuCaps {
  playNow?(): void;
  playNext?(): void;
  append?(): void;
  replaceQueue?(): void;
  /** Inserted after the queue verbs — the Library's "Play album from here". */
  extraQueueVerbs?: MediaMenuItem[];
  /** Inserted with the navigate verbs — the Library's box-set walk
   *  ("Next volume: …" on the open album's menu). Albums only. */
  extraNavVerbs?: MediaMenuItem[];
  /** Open the entity's home in the Library (favorites, search results). */
  openInLibrary?(): void;
  goToAlbum?(): void;
  goToArtist?(): void;
  /** The artist's page in the Library (the app's own, built from the indexes). Artists only. */
  openArtistPage?(): void;
  saveToPreset?(): void;
  addToPlaylist?(): void;
  /** Override the derived heart (the Library stores richer favorites). */
  heart?: { active: boolean; toggle(): void };
  /** Local verbs, appended last — Remove from queue, delete, unheart… */
  /** Once-and-done utilities (Analyze audio) — above Info…, which anchors
   *  the bottom as the every-time verb; only destructive terminals (extra)
   *  sit beneath it (amended 2026-08-31). */
  utilityVerbs?: MediaMenuItem[];
  extra?: MediaMenuItem[];
  /**
   * Open the Info modal on this entity — everything the DIDL said about it
   * (2026-08-16). A surface holding the real MediaNode (the Library) passes
   * its own; every other surface gets Info derived from the ref (infoItem).
   */
  info?(): void;
  /** The list this row sits in and its place there, so the derived Info steps through it
   *  (lib/infoSteps; tracks only). */
  infoList?: { refs: readonly MediaRef[]; index: number };
}

/**
 * "Info…" is DERIVED from the ref, like the heart: every entity menu offers
 * it, on every surface, without the surface knowing how (main looks the node
 * up — see lib/mediaInfo). A surface that already holds the full node (the
 * Library) passes `caps.info` and skips the lookup. Stations opt out.
 */
function infoItem(ref: MediaRef, caps: MediaMenuCaps): MediaMenuItem[] {
  if (caps.info) return [{ label: "Info…", run: caps.info }];
  if (ref.kind === "station") return [];
  return [{ label: "Info…", run: () => void openInfoForRef(ref, caps.infoList) }];
}

const pivotEntity = (ref: MediaRef): string =>
  ref.kind === "artist" ? ref.title : (ref.artist ?? ref.title);

function pivotItem(ref: MediaRef): MediaMenuItem[] {
  const entity = pivotEntity(ref).trim();
  if (!entity) return [];
  return [
    {
      label: `Search everything for “${entity}”`,
      run: () => useStore.getState().requestSearch(entity),
    },
  ];
}

function heartItem(ref: MediaRef, caps: MediaMenuCaps): MediaMenuItem[] {
  if (caps.heart) {
    return [
      {
        label: caps.heart.active ? "Remove from favorites" : "Add to favorites",
        run: caps.heart.toggle,
      },
    ];
  }
  const fav = refToFavorite(ref);
  if (!fav) return [];
  const active = isFavorited(fav, useStore.getState().favorites);
  return [
    {
      label: active ? "Remove from favorites" : "Add to favorites",
      run: () => void toggleFavorite(fav),
    },
  ];
}

const cap = (label: string, run?: () => void): MediaMenuItem[] => (run ? [{ label, run }] : []);

/** Order everywhere: play verbs · navigate (go-to / open / pivot) · write
 *  verbs (preset, playlist) · heart · utilities · Info… · destructive
 *  local extras last. */
export function trackMenuItems(ref: MediaRef, caps: MediaMenuCaps = {}): MediaMenuItem[] {
  return [
    ...cap("Play now", caps.playNow),
    ...cap("Play next", caps.playNext),
    ...cap("Add to end of queue", caps.append),
    ...cap("Replace queue", caps.replaceQueue),
    ...(caps.extraQueueVerbs ?? []),
    ...cap("Go to album", caps.goToAlbum),
    ...cap("Go to artist", caps.goToArtist),
    ...cap("Open in Library", caps.openInLibrary),
    ...pivotItem(ref),
    ...cap("Save to preset…", caps.saveToPreset),
    ...cap("Add to playlist…", caps.addToPlaylist),
    ...heartItem(ref, caps),
    ...(caps.utilityVerbs ?? []),
    ...infoItem(ref, caps),
    ...(caps.extra ?? []),
  ];
}

export function albumMenuItems(ref: MediaRef, caps: MediaMenuCaps = {}): MediaMenuItem[] {
  return [
    ...cap("Play", caps.playNow),
    ...cap("Play next", caps.playNext),
    ...cap("Add to end of queue", caps.append),
    ...cap("Replace queue", caps.replaceQueue),
    ...(caps.extraQueueVerbs ?? []),
    ...cap("Open in Library", caps.openInLibrary),
    ...(caps.extraNavVerbs ?? []),
    ...pivotItem(ref),
    ...cap("Save to preset…", caps.saveToPreset),
    ...cap("Add to playlist…", caps.addToPlaylist),
    ...heartItem(ref, caps),
    ...(caps.utilityVerbs ?? []),
    ...infoItem(ref, caps),
    ...(caps.extra ?? []),
  ];
}

/**
 * An artist's PICTURE verbs (0.13.0 rc.3, his pick: in the artist's menu everywhere, so a wrong
 * picture spotted among the Artists view's cards is changed there): Choose a picture… opens the
 * one chooser (ArtistPictureHost), and once a picture is chosen the reset, named for what comes
 * back. Derived like the heart, from the window's map of chosen pictures (lib/artistPictures).
 * The artist page's picture menu is these alone, with the page's own albums as the covers.
 */
export function artistPictureItems(name: string, covers?: readonly CoverOffer[]): MediaMenuItem[] {
  if (!name.trim()) return [];
  const chosen = artistChoiceNow(name);
  return [
    {
      label: "Choose a picture…",
      run: () => useStore.getState().setPictureChooser({ name, covers }),
    },
    ...(chosen
      ? [
          {
            label: chosen.photoAfter ? "Reset to the Wikipedia photo" : "Reset the picture",
            run: () => resetArtistPicture(name),
          },
        ]
      : []),
  ];
}

/** An artist's menu is the pivot and the picture verbs (plus local extras) —
 *  the queue verbs don't apply ("queue a whole artist" is undecided) and
 *  favorites key on album/track identity. Thin, but any future artist verb
 *  has a home here. */
export function artistMenuItems(ref: MediaRef, caps: MediaMenuCaps = {}): MediaMenuItem[] {
  return [
    ...cap("Open artist page", caps.openArtistPage),
    ...pivotItem(ref),
    ...artistPictureItems(ref.title),
    ...(caps.utilityVerbs ?? []),
    ...infoItem(ref, caps),
    ...(caps.extra ?? []),
  ];
}
