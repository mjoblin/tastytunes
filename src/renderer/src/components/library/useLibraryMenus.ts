import { useState } from "react";
import {
  albumTracksOf,
  artistSummary,
  discCountIn,
  discTrackCount,
  type MediaIndexPools,
  type MediaInfoTarget,
  type MediaNode,
  type MediaServerInfo,
} from "@shared/model";
import { usbServer } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { analyzeAlbum, analyzeTracks, USB_ANALYSIS_HINT } from "@/lib/audioAnalysis";
import { fmtCount } from "@/lib/format";
import { openInfoInList } from "@/lib/infoSteps";
import { isAlbumClass, isArtistClass } from "@/lib/media";
import type { MediaMenuItem } from "@/lib/mediaMenus";
import { itemFromNode } from "@/components/overlays/AddToPlaylistPanel";
import type { Crumb } from "@/screens/LibraryScreen";
import { menuAt } from "@/lib/menuAt";

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
  /** The artist's page by name (lensNavigation's, packed names resolved there). */
  openArtistPage(name: string): void;
}) {
  const { serverUdn, servers, path, nodeUdn, enter, lensPools, showToast, showNotice, late } = d;
  const mediaIndexStatuses = useStore((s) => s.mediaIndex);
  // The result links are INDEX-powered: only offer them when the ready index
  // actually holds the target pool — a folder-only or artist-less server
  // simply never shows them (graceful degradation to plain sublines).
  // Per-NODE, so cross-server rows gate against their own server's index.
  const linkable = (node: MediaNode, pool: "albums" | "artists"): boolean => {
    const idx = mediaIndexStatuses.find((x) => x.udn === nodeUdn(node));
    // an artist goes to their page, which the index builds whether or not the server lists
    // artists (the Evo's USB drive lists none)
    return idx?.state === "ready" && (pool === "artists" || idx[pool] > 0);
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

  /** Artist-as-link: the artist's page (2026-10-11), offered only where the track's server
   *  has a ready index (linkable), which the page is built from. */
  const goToArtist = (track: MediaNode): void => {
    if (track.artist) d.openArtistPage(track.artist);
  };

  // `list`: the rows the node sits in, for Info's ‹ › (lib/infoSteps)
  const [menu, setMenu] = useState<{
    node: MediaNode;
    x: number;
    y: number;
    list?: MediaNode[];
  } | null>(null);
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
  // a track's "of 12" on its disc for the Info header: the open album's own listing when the
  // track is in it (an album browsed from the server's folders has no index pools; his Only God
  // Was Above Us read "track 1"), else the index
  const discCountForInfo = (node: MediaNode): number | null => {
    if (node.isContainer) return null;
    const { albumNode, allTracks } = late.current;
    if (albumNode && allTracks?.some((t) => t.id === node.id)) return discCountIn(node, allTracks);
    const pool = lensPools?.find((g) => g.udn === node.serverUdn);
    return pool ? discTrackCount(node, pool) : null;
  };
  // THE LIBRARY'S INFO, ONE HOME (0.12.0, with ⌘I; it lived inline in the menu's Info…): the
  // target a node's Info shows (an artist's page summed by NAME from the index, the lens's merged
  // rows and the server's person entities alike; an album's tracks; a track's place on its disc)
  // and its opening, a track stepping through the rows it was opened from (lib/infoSteps). The
  // menus' Info… and ⌘I on an album or an artist's page both open through it.
  const infoTargetFor = (n: MediaNode): MediaInfoTarget => {
    const server = servers?.find((x) => x.udn === serverUdn) ?? null;
    const pool = lensPools?.find((g) => g.udn === (n.serverUdn ?? server?.udn)) ?? lensPools?.[0];
    const artist =
      n.isContainer && isArtistClass(n.upnpClass) && pool
        ? artistSummary(n.title, pool)
        : undefined;
    const count = discCountForInfo(n);
    return {
      node: artist && !n.artUrl && artist.artUrl ? { ...n, artUrl: artist.artUrl } : n,
      tracks: artist ? undefined : tracksForInfo(n),
      artist,
      ...(count != null ? { discTrackCount: count } : {}),
      serverName: n.serverName ?? server?.name ?? null,
      serverUdn: nodeUdn(n),
      // what the index learned about this server (the modal's Indexed line + notes)
      ...(pool?.profile ? { serverProfile: pool.profile } : {}),
    };
  };
  const openInfoFor = (n: MediaNode, list?: readonly MediaNode[]): void => {
    const at = !n.isContainer && list ? list.indexOf(n) : -1;
    if (list && at >= 0 && list.length > 1)
      openInfoInList(
        infoTargetFor(n),
        list.map((t) => () => infoTargetFor(t)),
        at,
      );
    else useStore.getState().setMediaInfo(infoTargetFor(n));
  };
  const [presetPicker, setPresetPicker] = useState<{
    node: MediaNode;
    x: number;
    y: number;
  } | null>(null);
  // The card/row a popover belongs to holds its hover treatment while open.
  const menuNodeId = menu?.node.id ?? presetPicker?.node.id ?? null;
  const openMenu = (node: MediaNode, e: React.MouseEvent, list?: MediaNode[]): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ node, ...menuAt(e), list });
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
    else
      showToast({
        kind: "success",
        text: `“${node.title}” analyzed${r.again ? " again" : ""}: DR${r.dr}`,
      });
  };
  /** The album selection bar's Analyze audio (0.8.0): each album's own sweep in
   *  turn, so every one lands its album DR; the sweep queue serializes them. */
  /** True for a node on the streamer's own server, whose audio the app cannot
   *  read (USB_ANALYSIS_HINT says why); the verbs below refuse it up front. */
  const unreadable = (node: MediaNode): boolean => {
    const udn = nodeUdn(node);
    const server = udn != null ? servers?.find((s) => s.udn === udn) : undefined;
    return server != null && usbServer(server);
  };
  const runAnalyzeAlbums = async (nodes: MediaNode[]): Promise<void> => {
    const readable = nodes.filter((n) => !unreadable(n));
    if (readable.length === 0 && nodes.length > 0) {
      showNotice(USB_ANALYSIS_HINT);
      return;
    }
    for (const node of readable) {
      const udn = nodeUdn(node);
      if (udn) await runAnalyzeAlbum(node, udn);
    }
  };
  /** The Tracks lens's sweep over what's shown — the album sweep's toasts,
   *  minus the album DR (a filter is not an album). */
  const runAnalyzeTracks = async (chosen: MediaNode[], label: string): Promise<void> => {
    const readable = chosen.filter((n) => !unreadable(n));
    if (readable.length === 0 && chosen.length > 0) {
      showNotice(USB_ANALYSIS_HINT);
      return;
    }
    showToast({ kind: "success", text: `Analyzing ${label}…` });
    const r = await analyzeTracks(label, readable);
    if (r === "busy" || r == null) return;
    // one track by its name, more by their count; "again" when all were current and every one
    // was measured again (lib/audioAnalysis' againIfDone)
    if (r.analyzed === r.tracks)
      showToast({
        kind: "success",
        text: `Analyzed ${r.tracks === 1 && chosen.length === 1 ? label : `${fmtCount(r.tracks)} tracks`}${r.again ? " again" : ""}`,
      });
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
  // an album's, and since 0.12.0 a track's (his ask: one track measured again, as an album's
  // sweep does; a current analysis is kept, an earlier version's re-measured)
  const analyzeVerbs = (node: MediaNode): MediaMenuItem[] | undefined => {
    const track = !node.isContainer;
    if (!waveformsOn || (!track && !isAlbumClass(node.upnpClass))) return undefined;
    const udn = nodeUdn(node);
    if (!udn) return undefined;
    // the streamer's own server: the verb stays, disabled, saying why — the
    // outcome is known before the click, and a vanished item teaches nothing
    if (unreadable(node))
      return [{ label: "Analyze audio", disabled: true, hint: USB_ANALYSIS_HINT, run: () => {} }];
    return [
      {
        label: "Analyze audio",
        run: () =>
          void (track
            ? runAnalyzeTracks([{ ...node, serverUdn: udn }], `“${node.title}”`)
            : runAnalyzeAlbum(node, udn)),
      },
    ];
  };

  // A SERVER'S OWN RECENTLY ADDED LIST, chosen where it lives (0.13.0 round 9): a folder the
  // reader is browsing on a server, or a list-like container (Asset's New Albums is a plain
  // album container, never a musicAlbum), never an artist or an album of tracks
  const recentListVerbs = (node: MediaNode): MediaMenuItem[] | undefined => {
    if (!serverUdn || !node.isContainer || isArtistClass(node.upnpClass)) return undefined;
    if (node.upnpClass.startsWith("object.container.album.musicAlbum")) return undefined;
    if ((nodeUdn(node) ?? serverUdn) !== serverUdn) return undefined;
    const choice = {
      id: node.id,
      title: node.title,
      titlePath: [...path.map((c) => c.title), node.title],
    };
    // the list in use already: said, not offered again
    const inUse = mediaIndexStatuses.find((x) => x.udn === serverUdn)?.recentList;
    if (inUse?.title === node.title)
      return [
        {
          label: "Use as Recently added",
          disabled: true,
          hint: "Recently added comes from here. Settings › Libraries turns it off.",
          run: () => {},
        },
      ];
    return [
      {
        label: "Use as Recently added",
        run: () =>
          void tt
            .setRecentlyAddedList(serverUdn, choice)
            .then(() =>
              showToast({ kind: "success", text: `Set Recently added to “${node.title}”` }),
            ),
      },
    ];
  };

  return {
    recentListVerbs,
    menu,
    setMenu,
    presetPicker,
    setPresetPicker,
    menuNodeId,
    openMenu,
    openInfoFor,
    volumeNavVerbs,
    analyzeVerbs,
    linkable,
    goToAlbum,
    goToArtist,
    runAnalyzeAlbums,
    runAnalyzeTracks,
    saveNodesAsPlaylist,
    unreadable,
  };
}
