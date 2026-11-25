// A SEARCH RESULT'S ⋯ AND RIGHT-CLICK (moved out of SearchScreen.tsx as they were, 0.16.0's tidy): the
// menu, the add-to-playlist panel and the preset picker it opens, built from the shared per-entity
// builders.
import { useState } from "react";
import type { Favorite, MediaNode, PlaylistItem } from "@shared/model";
import { tt } from "@/api";
import { RowMenu } from "@/components/media/RowMenu";
import { AddToPlaylistPanel } from "@/components/overlays/AddToPlaylistPanel";
import { PresetPicker } from "@/components/library/LibraryMenus";
import { favoriteAct } from "@/lib/favorites";
import { fromFavorite, fromNode, refToPlaylistItem, type MediaRef } from "@/lib/mediaRef";
import { refSiblings } from "@/lib/infoSteps";
import { openArtistInLibrary, saveRefToPreset } from "@/lib/mediaActions";
import {
  albumMenuItems,
  artistMenuItems,
  trackMenuItems,
  type MediaMenuItem,
} from "@/lib/mediaMenus";
import { menuAt } from "@/lib/menuAt";
import { nodeKind } from "./searchKit";

/** The open ⋯ menu: its title, where it opened, and its items. */
export type SearchRowMenu = { title: string; x: number; y: number; items: MediaMenuItem[] };

export function useSearchMenus(
  libShown: MediaNode[],
  playNode: (node: MediaNode) => void,
  openFavorite: (f: Favorite) => void,
): {
  openNodeMenu(node: MediaNode, e: React.MouseEvent): void;
  openFavMenu(f: Favorite, e: React.MouseEvent): void;
  setRowMenu(menu: SearchRowMenu | null): void;
  overlays: React.JSX.Element;
} {
  // ---- the ⋯ (and right-click): items built at open time from the shared
  // ---- per-entity builders, so a result's menu is the same menu the Library,
  // ---- Queue and Favorites show for the same thing
  const [rowMenu, setRowMenu] = useState<SearchRowMenu | null>(null);
  const [playlistFor, setPlaylistFor] = useState<{
    label: string;
    x: number;
    y: number;
    resolve(): Promise<PlaylistItem[]>;
  } | null>(null);
  const [presetFor, setPresetFor] = useState<{ ref: MediaRef; x: number; y: number } | null>(null);

  const openNodeMenu = (node: MediaNode, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const ref = fromNode(node);
    const udn = node.serverUdn;
    const at = menuAt(e);
    const queueVerb = (action: "PLAY_NOW" | "PLAY_NEXT" | "APPEND" | "REPLACE") =>
      udn ? () => void tt.mediaQueueAdd(udn, node.id, action) : undefined;
    const caps = {
      playNow: queueVerb("PLAY_NOW"),
      playNext: queueVerb("PLAY_NEXT"),
      append: queueVerb("APPEND"),
      replaceQueue: queueVerb("REPLACE"),
      saveToPreset: () => setPresetFor({ ref, ...at }),
      addToPlaylist: () =>
        setPlaylistFor({
          label: node.title,
          ...at,
          resolve: async () => {
            if (!node.isContainer) return [refToPlaylistItem(ref)];
            if (!udn) return [];
            // an album expands to its TRACKS — a playlist stores tracks
            const children = await tt.mediaBrowse(udn, node.id, []);
            return children
              .filter((c) => !c.isContainer)
              .map((c) => refToPlaylistItem(fromNode(c, udn)));
          },
        }),
    };
    const kind = nodeKind(node);
    const items =
      kind === "artist"
        ? artistMenuItems(ref, { openArtistPage: () => openArtistInLibrary(node.title) })
        : kind === "album"
          ? albumMenuItems(ref, {
              ...caps,
              openInLibrary: () => playNode(node), // container click contract: open
            })
          : trackMenuItems(ref, {
              ...caps,
              // Info steps through the library's results as shown (lib/infoSteps)
              infoList: refSiblings(libShown, node, (n) => fromNode(n)),
            });
    setRowMenu({ title: node.title, ...at, items });
  };

  const openFavMenu = (f: Favorite, e: React.MouseEvent): void => {
    if (f.kind === "station") return; // stations: heart + click; no menu anywhere
    const media = f;
    e.preventDefault();
    e.stopPropagation();
    const ref = fromFavorite(media);
    const at = menuAt(e);
    const favQueue = (action: "PLAY_NEXT" | "APPEND" | "REPLACE") => () =>
      void favoriteAct(media, (udn, id) => tt.mediaQueueAdd(udn, id, action));
    const caps = {
      playNext: favQueue("PLAY_NEXT"),
      append: favQueue("APPEND"),
      replaceQueue: favQueue("REPLACE"),
      saveToPreset: () => setPresetFor({ ref, ...at }),
      addToPlaylist: () =>
        setPlaylistFor({
          label: media.title,
          ...at,
          resolve: async () => {
            if (media.kind === "track") return [refToPlaylistItem(ref)];
            const items: PlaylistItem[] = [];
            await favoriteAct(media, async (udn, id) => {
              const children = await tt.mediaBrowse(udn, id, media.titlePath ?? [media.title]);
              for (const c of children)
                if (!c.isContainer) items.push(refToPlaylistItem(fromNode(c, udn)));
            });
            return items;
          },
        }),
    };
    setRowMenu({
      title: media.title,
      ...at,
      items:
        media.kind === "album"
          ? albumMenuItems(ref, { ...caps, playNow: () => openFavorite(f) })
          : trackMenuItems(ref, { ...caps, playNow: () => openFavorite(f) }),
    });
  };

  const overlays = (
    <>
      {rowMenu && (
        <RowMenu
          title={rowMenu.title}
          at={{ x: rowMenu.x, y: rowMenu.y }}
          onClose={() => setRowMenu(null)}
          items={rowMenu.items}
        />
      )}
      {playlistFor && (
        <AddToPlaylistPanel
          label={playlistFor.label}
          at={{ x: playlistFor.x, y: playlistFor.y }}
          onClose={() => setPlaylistFor(null)}
          resolve={playlistFor.resolve}
        />
      )}
      {presetFor && (
        <PresetPicker
          picker={{ node: { title: presetFor.ref.title }, x: presetFor.x, y: presetFor.y }}
          onClose={() => setPresetFor(null)}
          onSave={async (slot, name) => {
            await saveRefToPreset(presetFor.ref, slot, name);
            setPresetFor(null);
          }}
        />
      )}
    </>
  );

  return { openNodeMenu, openFavMenu, setRowMenu, overlays };
}
