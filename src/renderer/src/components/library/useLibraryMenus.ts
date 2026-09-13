import { useState } from "react";
import {
  albumTracksOf,
  type MediaIndexPools,
  type MediaNode,
  type MediaServerInfo,
} from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { analyzeAlbum, analyzeTracks } from "@/lib/audioAnalysis";
import { fmtCount } from "@/lib/format";
import { isAlbumClass } from "@/lib/media";
import type { MediaMenuItem } from "@/lib/mediaMenus";
import { itemFromNode } from "@/components/overlays/AddToPlaylistPanel";
import type { Crumb } from "@/screens/LibraryScreen";

// The Library's MENUS, lifted out of LibraryScreen (2026-09-13, the second
// lift of the screen's hygiene round, after search mode): the open menu and
// the preset picker, the ⋯ menu's verb builders (the box set's volume walk,
// Analyze audio), the analysis sweeps and the playlist save they run, and the
// index-powered link resolvers behind Go to album and Go to artist. The screen
// keeps the menus' rendering (ItemMenu, RowMenu, PresetPicker) and the actions
// they call, and takes the state and the builders back under the old names.

/** What the builders read that the screen derives after the hook runs (the
 *  open album and its volume siblings, the visible tracks): reached
 *  late-bound, read at render or event time, never captured. */
export interface MenusLate {
  albumNode: MediaNode | null;
  setSiblings: MediaNode[] | null;
  openVolume(a: MediaNode): void;
  allTracks: MediaNode[];
}

export function useLibraryMenus(d: {
  serverUdn: string | null;
  servers: MediaServerInfo[] | null;
  path: Crumb[];
  nodeUdn(node: MediaNode): string | null;
  enter(node: MediaNode): void;
  lensPools: MediaIndexPools[] | null;
  showToast: ReturnType<typeof useStore.getState>["showToast"];
  showNotice(msg: string): void;
  late: { current: MenusLate };
}) {
  const { serverUdn, servers, path, nodeUdn, enter, lensPools, showToast, showNotice, late } = d;
  const mediaIndexStatuses = useStore((s) => s.mediaIndex);
  // The result links are INDEX-powered: only offer them when the ready index
  // actually holds the target pool — a folder-only or artist-less server
  // simply never shows them (graceful degradation to plain sublines).
  // Per-NODE, so cross-server rows gate against their own server's index.
  const linkable = (node: MediaNode, pool: "albums" | "artists"): boolean => {
    const idx = mediaIndexStatuses.find((x) => x.udn === nodeUdn(node));
    return idx?.state === "ready" && idx[pool] > 0;
  };

  /** Album-as-link: resolve a track's album by content identity against the
   *  (index-first) search and enter it — same crumb behavior as clicking an
   *  album result, so the search trail stays returnable. */
  const goToAlbum = async (track: MediaNode): Promise<void> => {
    const udn = nodeUdn(track);
    if (!udn || !track.album) return;
    const lc = (x: string | null): string => (x ?? "").trim().toLowerCase();
    try {
      const { items } = await tt.mediaSearch(udn, track.album);
      const albums = items.filter(
        (n) => isAlbumClass(n.upnpClass) && lc(n.title) === lc(track.album),
      );
      const album =
        albums.find(
          (n) => track.artist == null || n.artist == null || lc(n.artist) === lc(track.artist),
        ) ?? albums[0];
      if (!album) {
        showNotice(`Couldn't find "${track.album}" in this library.`);
        return;
      }
      // carry the track's server stamp so entering from a cross view scopes right
      enter(track.serverUdn ? { ...album, serverUdn: udn, serverName: track.serverName } : album);
    } catch {
      showNotice(`Couldn't find "${track.album}" in this library.`);
    }
  };

  /** Artist-as-link: same content-identity resolution, aimed at the artist
   *  entity. Failure degrades to a quiet toast, never a broken screen. */
  const goToArtist = async (track: MediaNode): Promise<void> => {
    const udn = nodeUdn(track);
    if (!udn || !track.artist) return;
    const lc = (x: string | null): string => (x ?? "").trim().toLowerCase();
    try {
      const { items } = await tt.mediaSearch(udn, track.artist);
      const artist = items.find(
        (n) =>
          n.isContainer &&
          (n.upnpClass.includes("person") || n.upnpClass.includes("Artist")) &&
          lc(n.title) === lc(track.artist),
      );
      if (!artist) {
        showNotice(`Couldn't find "${track.artist}" in this library.`);
        return;
      }
      enter(track.serverUdn ? { ...artist, serverUdn: udn, serverName: track.serverName } : artist);
    } catch {
      showNotice(`Couldn't find "${track.artist}" in this library.`);
    }
  };

  const [menu, setMenu] = useState<{ node: MediaNode; x: number; y: number } | null>(null);
  // The Info modal wants an album's tracks summed: the browsed album's own
  // listing when the node IS the open album; otherwise the lens's index
  // (same server, same title, album artist / performers, and — when twin
  // editions exist — the same art), i.e. exactly what the lens itself lists.
  const tracksForInfo = (node: MediaNode): MediaNode[] | undefined => {
    const { albumNode, allTracks } = late.current;
    if (!node.isContainer) return undefined;
    if (albumNode && node.id === albumNode.id) return allTracks;
    if (!lensPools || !node.serverUdn) return undefined;
    const pool = lensPools.find((g) => g.udn === node.serverUdn);
    return pool ? albumTracksOf(node, pool) : undefined;
  };
  const [presetPicker, setPresetPicker] = useState<{
    node: MediaNode;
    x: number;
    y: number;
  } | null>(null);
  // The card/row a popover belongs to holds its hover treatment while open.
  const menuNodeId = menu?.node.id ?? presetPicker?.node.id ?? null;
  const openMenu = (node: MediaNode, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ node, x: e.clientX, y: e.clientY });
  };

  /** ⋯-menu garnish on a box set's open album: the volume walk as named
   *  verbs, so menu-first users see the same navigation the pills offer. */
  const volumeNavVerbs = (node: MediaNode): MediaMenuItem[] | undefined => {
    const { albumNode, setSiblings, openVolume } = late.current;
    if (!setSiblings || !albumNode || node.id !== albumNode.id) return undefined;
    const i = setSiblings.findIndex((a) => a.id === albumNode.id);
    if (i < 0) return undefined;
    const verbs: MediaMenuItem[] = [];
    const prev = setSiblings[i - 1];
    const next = setSiblings[i + 1];
    if (prev)
      verbs.push({
        label: `Previous volume: ${prev.title}`,
        run: () => openVolume(prev),
      });
    if (next) verbs.push({ label: `Next volume: ${next.title}`, run: () => openVolume(next) });
    return verbs.length > 0 ? verbs : undefined;
  };

  // EXPERIMENT (0.7 exploration): the Analyze-audio sweep — every track of
  // the album measured and cached, the album DR recorded when the set
  // completes. Album menus only, gated on the waveforms master like all
  // audio analysis.
  const waveformsOn = useStore((s) => s.settings.waveforms);
  const runAnalyzeAlbum = async (node: MediaNode, udn: string): Promise<void> => {
    showToast({ kind: "success", text: `Analyzing “${node.title}”…` });
    const r = await analyzeAlbum(
      node,
      udn,
      path.map((c) => c.title),
    );
    if (r === "busy") return; // the running sweep's own toast will land
    if (r == null) showNotice(`Couldn't read “${node.title}” from the server.`);
    else if (r.dr == null)
      showNotice(`Read ${r.analyzed} of ${r.tracks} tracks. An album DR needs all of them.`);
    else showToast({ kind: "success", text: `“${node.title}” analyzed: DR${r.dr}` });
  };
  /** The album selection bar's Analyze audio (0.8.0): each album's own sweep in
   *  turn, so every one lands its album DR; the sweep queue serializes them. */
  const runAnalyzeAlbums = async (nodes: MediaNode[]): Promise<void> => {
    for (const node of nodes) {
      const udn = nodeUdn(node);
      if (udn) await runAnalyzeAlbum(node, udn);
    }
  };
  /** The Tracks lens's sweep over what's shown — the album sweep's toasts,
   *  minus the album DR (a filter is not an album). */
  const runAnalyzeTracks = async (chosen: MediaNode[], label: string): Promise<void> => {
    showToast({ kind: "success", text: `Analyzing ${label}…` });
    const r = await analyzeTracks(label, chosen);
    if (r === "busy" || r == null) return;
    if (r.analyzed === r.tracks)
      showToast({ kind: "success", text: `Analyzed ${fmtCount(r.tracks)} tracks` });
    else showNotice(`Read ${r.analyzed} of ${r.tracks} tracks. The rest couldn't be read.`);
  };
  /** One-click save of a shown list as a playlist (the Queue's precedent:
   *  auto-named, toasted with the STORED name, undoable as a create). */
  const saveNodesAsPlaylist = async (chosen: MediaNode[], name: string): Promise<void> => {
    const items = chosen.map((node) => {
      const udn = node.serverUdn ?? serverUdn;
      const sname = servers?.find((s) => s.udn === udn)?.name ?? null;
      return itemFromNode(node, udn, sname);
    });
    if (items.length === 0) return;
    try {
      const created = await tt.playlistCreate(name, items);
      useStore
        .getState()
        .pushUndo(`Create Playlist “${created.name}”`, () => void tt.playlistDelete(created.id));
      showToast({
        kind: "success",
        text: `Saved ${fmtCount(items.length)} tracks as “${created.name}”`,
        action: { label: "Open Playlists", screen: "playlists" },
      });
    } catch {
      showNotice("Couldn't create the playlist.");
    }
  };
  const analyzeVerbs = (node: MediaNode): MediaMenuItem[] | undefined => {
    if (!waveformsOn || !node.isContainer || !isAlbumClass(node.upnpClass)) return undefined;
    const udn = nodeUdn(node);
    if (!udn) return undefined;
    return [{ label: "Analyze audio", run: () => void runAnalyzeAlbum(node, udn) }];
  };

  return {
    menu,
    setMenu,
    presetPicker,
    setPresetPicker,
    menuNodeId,
    openMenu,
    tracksForInfo,
    volumeNavVerbs,
    analyzeVerbs,
    linkable,
    goToAlbum,
    goToArtist,
    runAnalyzeAlbums,
    runAnalyzeTracks,
    saveNodesAsPlaylist,
  };
}
