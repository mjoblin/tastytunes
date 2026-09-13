import type { MediaIndexPools, MediaNode, MediaQueueAction, MediaServerInfo } from "@shared/model";
import { artistSummary } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { isAlbumClass, isArtistClass } from "@/lib/media";
import { ItemMenu, PresetPicker } from "@/components/library/LibraryMenus";
import { RowMenu } from "@/components/media/RowMenu";
import { AddToPlaylistPanel, itemFromNode } from "@/components/overlays/AddToPlaylistPanel";
import type { Lens } from "@/components/library/lensNavigation";
import type { useLibraryFavorites } from "@/components/library/useLibraryFavorites";
import type { useLibraryMenus } from "@/components/library/useLibraryMenus";
import type { useLibrarySelection } from "@/components/library/useLibrarySelection";

// The Library's POPOVERS over the listing, lifted out of LibraryScreen's render
// (2026-09-13, the fifth lift of the screen's hygiene round): the ⋯ menu on an
// item or on the whole selection, the two playlist panels, the preset picker
// and the drag ghost. Every input is the screen's own state or the hooks' —
// the props are picked from what those hooks return, so the types stay one.

type Sel = ReturnType<typeof useLibrarySelection>;
type Men = ReturnType<typeof useLibraryMenus>;
type Fav = ReturnType<typeof useLibraryFavorites>;

export function LibraryPopovers(
  p: Pick<
    Sel,
    | "selTracks"
    | "setSelTracks"
    | "queueSelected"
    | "playlistMulti"
    | "setPlaylistMulti"
    | "selectedNodes"
  > &
    Pick<
      Men,
      | "menu"
      | "setMenu"
      | "presetPicker"
      | "setPresetPicker"
      | "volumeNavVerbs"
      | "analyzeVerbs"
      | "linkable"
      | "goToAlbum"
      | "goToArtist"
      | "tracksForInfo"
    > &
    Pick<Fav, "nodeFavorited" | "heartNode" | "heartNodes"> & {
      savePreset(node: MediaNode, slot: number, name: string | null): Promise<void>;
      lens: Lens | null;
      searchMode: boolean;
      goToAlbumFromLens(node: MediaNode): void;
      goToArtistFromLens(node: MediaNode): void;
      playContainer(node: MediaNode, el: HTMLElement | null): Promise<void>;
      playAlbumFrom(track: MediaNode): Promise<void>;
      act(
        node: MediaNode,
        action: MediaQueueAction,
        el: HTMLElement | null,
        playFromId?: string,
      ): Promise<void>;
      lensPools: MediaIndexPools[] | null;
      server: MediaServerInfo | null;
      setMediaInfo: ReturnType<typeof useStore.getState>["setMediaInfo"];
      nodeUdn(node: MediaNode): string | null;
      playlistPicker: { node: MediaNode; x: number; y: number } | null;
      setPlaylistPicker(picker: { node: MediaNode; x: number; y: number } | null): void;
      serverUdn: string | null;
      servers: MediaServerInfo[] | null;
      /** The nav drag's ghost, rendered with the layer. */
      ghost: React.ReactNode;
    },
): React.JSX.Element {
  const {
    menu,
    setMenu,
    selTracks,
    setSelTracks,
    queueSelected,
    playlistMulti,
    setPlaylistMulti,
    selectedNodes,
    nodeFavorited,
    heartNode,
    heartNodes,
    volumeNavVerbs,
    analyzeVerbs,
    linkable,
    goToAlbum,
    goToArtist,
    tracksForInfo,
    presetPicker,
    setPresetPicker,
    savePreset,
    lens,
    searchMode,
    goToAlbumFromLens,
    goToArtistFromLens,
    playContainer,
    playAlbumFrom,
    act,
    lensPools,
    server,
    setMediaInfo,
    nodeUdn,
    playlistPicker,
    setPlaylistPicker,
    serverUdn,
    servers,
    ghost,
  } = p;
  return (
    <>
      {/* a menu invoked ON a selected track speaks for the whole selection,
          pluralized — the Finder/Spotify convention */}
      {menu && !menu.node.isContainer && selTracks.has(menu.node.id) && selTracks.size > 1 && (
        <RowMenu
          title={`${selTracks.size} tracks`}
          at={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={[
            { label: "Play now", run: () => void queueSelected("now") },
            { label: "Play next", run: () => void queueSelected("next") },
            { label: "Add to end of queue", run: () => void queueSelected("append") },
            {
              label: "Add to playlist…",
              run: () => setPlaylistMulti({ nodes: selectedNodes(), x: menu.x, y: menu.y }),
            },
            (() => {
              const nodes = selectedNodes();
              const allIn = nodes.length > 0 && nodes.every(nodeFavorited);
              return {
                label: allIn ? "Remove from favorites" : "Add to favorites",
                run: () => heartNodes(nodes, allIn),
              };
            })(),
          ]}
        />
      )}
      {menu && !(!menu.node.isContainer && selTracks.has(menu.node.id) && selTracks.size > 1) && (
        <ItemMenu
          menu={menu}
          onClose={() => setMenu(null)}
          navVerbs={volumeNavVerbs(menu.node)}
          utilityVerbs={analyzeVerbs(menu.node)}
          goToAlbum={
            lens === "tracks" && !menu.node.isContainer && menu.node.album
              ? () => {
                  setMenu(null);
                  goToAlbumFromLens(menu.node);
                }
              : searchMode &&
                  !menu.node.isContainer &&
                  menu.node.album &&
                  linkable(menu.node, "albums")
                ? () => {
                    setMenu(null);
                    void goToAlbum(menu.node);
                  }
                : undefined
          }
          goToArtist={
            lens === "tracks" && !menu.node.isContainer && menu.node.artist
              ? () => {
                  setMenu(null);
                  goToArtistFromLens(menu.node);
                }
              : searchMode &&
                  !menu.node.isContainer &&
                  menu.node.artist &&
                  linkable(menu.node, "artists")
                ? () => {
                    setMenu(null);
                    void goToArtist(menu.node);
                  }
                : undefined
          }
          onAction={(action, playFromId) => {
            setMenu(null);
            if (action === "PLAY") void playContainer(menu.node, null);
            else if (action === "PLAY_FROM_HERE") void playAlbumFrom(menu.node);
            else void act(menu.node, action, null, playFromId);
          }}
          onSavePreset={() => {
            setPresetPicker({ node: menu.node, x: menu.x, y: menu.y });
            setMenu(null);
          }}
          onInfo={() => {
            setMenu(null);
            const n = menu.node;
            // an artist's page is summed by NAME from the index (albums,
            // credits) — the lens's merged rows and the server's person
            // entities alike; without a pool the modal shows what it has
            const pool =
              lensPools?.find((g) => g.udn === (n.serverUdn ?? server?.udn)) ?? lensPools?.[0];
            const artist =
              n.isContainer && isArtistClass(n.upnpClass) && pool
                ? artistSummary(n.title, pool)
                : undefined;
            setMediaInfo({
              node: artist && !n.artUrl && artist.artUrl ? { ...n, artUrl: artist.artUrl } : n,
              tracks: artist ? undefined : tracksForInfo(n),
              artist,
              serverName: n.serverName ?? server?.name ?? null,
              serverUdn: nodeUdn(n),
              // what the index learned about this server (the modal's Indexed line + notes)
              ...(pool?.profile ? { serverProfile: pool.profile } : {}),
            });
          }}
          onAddToPlaylist={
            !menu.node.isContainer || isAlbumClass(menu.node.upnpClass)
              ? () => {
                  setPlaylistPicker({ node: menu.node, x: menu.x, y: menu.y });
                  setMenu(null);
                }
              : undefined
          }
          // Back-link for the builders' search pivot: a browse pivot returns
          // via the position restore, a pivot out of SEARCH MODE returns via
          // find-recall (its browse position is just the search's scope root).
          // Albums and tracks are heartable; plain folders and artists aren't.
          favorite={
            !menu.node.isContainer || isAlbumClass(menu.node.upnpClass)
              ? {
                  active: nodeFavorited(menu.node),
                  toggle: () => {
                    heartNode(menu.node);
                    setMenu(null);
                  },
                }
              : undefined
          }
        />
      )}
      {ghost}
      {playlistMulti && (
        <AddToPlaylistPanel
          label={`${playlistMulti.nodes.length} tracks`}
          at={{ x: playlistMulti.x, y: playlistMulti.y }}
          onClose={() => setPlaylistMulti(null)}
          resolve={() => {
            const items = playlistMulti.nodes.map((node) => {
              const udn = node.serverUdn ?? serverUdn;
              const name = servers?.find((s) => s.udn === udn)?.name ?? null;
              return itemFromNode(node, udn, name);
            });
            if (!playlistMulti.keepSelection) setSelTracks(new Set());
            playlistMulti.clear?.();
            return Promise.resolve(items);
          }}
        />
      )}
      {playlistPicker && (
        <AddToPlaylistPanel
          label={playlistPicker.node.title}
          at={{ x: playlistPicker.x, y: playlistPicker.y }}
          onClose={() => setPlaylistPicker(null)}
          resolve={async () => {
            const node = playlistPicker.node;
            const udn = node.serverUdn ?? serverUdn;
            const name = servers?.find((s) => s.udn === udn)?.name ?? null;
            if (!node.isContainer) return [itemFromNode(node, udn, name)];
            // An album expands to its TRACKS — a playlist stores tracks, not a
            // reference that would drift as the server's album changes.
            if (!udn) return [];
            const children = await tt.mediaBrowse(udn, node.id, []);
            return children.filter((c) => !c.isContainer).map((c) => itemFromNode(c, udn, name));
          }}
        />
      )}
      {presetPicker && (
        <PresetPicker
          picker={presetPicker}
          onClose={() => setPresetPicker(null)}
          onSave={(slot, name) => savePreset(presetPicker.node, slot, name)}
        />
      )}
    </>
  );
}
