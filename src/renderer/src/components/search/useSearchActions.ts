// WHAT A SEARCH RESULT'S CLICK DOES (moved out of SearchScreen.tsx as it was, 0.16.0's tidy): a library
// result and a favorite, each delegating to the helper its own screen uses.
import type { Favorite, MediaNode } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { favoriteAct } from "@/lib/favorites";
import { openArtistInLibrary } from "@/lib/mediaActions";
import { playStation } from "@/lib/radio";
import { nodeKind } from "./searchKit";

export function useSearchActions(): {
  playNode(node: MediaNode): void;
  openFavorite(f: Favorite): void;
} {
  const openInLibrary = useStore((s) => s.openInLibrary);
  const showToast = useStore((s) => s.showToast);

  // ---- actions. Every one delegates to the same helper its own screen uses.

  const playNode = (node: MediaNode): void => {
    const udn = node.serverUdn;
    if (!udn) return;
    // an ARTIST opens their page in the Library (2026-10-11): Search's results are the indexes',
    // and the page is built from them, the same on every server
    if (nodeKind(node) === "artist") {
      openArtistInLibrary(node.title);
      return;
    }
    if (node.isContainer) {
      openInLibrary({
        serverUdn: udn,
        objectId: node.id,
        titlePath: [node.title],
        title: node.title,
        upnpClass: node.upnpClass,
        fromSearch: true,
      });
      return;
    }
    void tt.mediaQueueAdd(udn, node.id, "PLAY_NOW");
  };

  const openFavorite = (f: Favorite): void => {
    if (f.kind === "station") {
      void playStation({ url: f.url, name: f.name, favicon: f.favicon });
      return;
    }
    const media = f;
    if (media.kind === "album") {
      void favoriteAct(media, async (udn, id) => {
        await tt.mediaBrowse(udn, id, media.titlePath ?? [media.title]);
        openInLibrary({
          serverUdn: udn,
          objectId: id,
          titlePath: media.titlePath ?? [media.title],
          title: media.title,
          fromSearch: true,
        });
      });
      return;
    }
    void (async () => {
      const res = await favoriteAct(media, (udn, id) => tt.mediaQueueAdd(udn, id, "PLAY_NOW"));
      if (res === "missing" || res === "no-server") {
        showToast({ kind: "error", text: `Couldn't find “${media.title}”` });
      }
    })();
  };

  return { playNode, openFavorite };
}
