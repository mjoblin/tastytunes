// THE SEARCH SCREEN'S FIVE CATEGORIES, AS DATA (moved out of SearchScreen.tsx as they were, 0.16.0's
// tidy): the library, presets, playlists, favorites and radio, each with its rows; the scopes a
// later unified Search will work from.
import { useMemo } from "react";
import { MoreHorizontal, Play } from "lucide-react";
import type { Favorite, MediaNode, Playlist, RadioStation } from "@shared/model";
import { favoriteKey } from "@shared/model";
import type { PresetItem } from "@shared/smoip";
import { nameKey } from "@shared/keys";
import { tt } from "@/api";
import { useStore } from "@/store";
import { MediaRow } from "@/components/media/MediaRow";
import { StationRow } from "@/components/media/StationRow";
import { RowAction } from "@/components/media/RowAction";
import { RowHeart } from "@/components/media/RowHeart";
import { isFavorited, toggleFavorite } from "@/lib/favorites";
import { activatePlaylist } from "@/lib/playlists";
import { fromNode, refToFavorite, type MediaRef } from "@/lib/mediaRef";
import { playingStationName, stationMenuItems } from "@/lib/radio";
import { useStationTuning } from "@/hooks/useStationTuning";
import { useLitPresets } from "@/hooks/useLitPresets";
import { menuAt } from "@/lib/menuAt";
import { SEARCH_CATEGORIES, type SearchCategoryId, type SearchGroup } from "@/lib/searchGroups";
import { kindLabel, nodeKind, type SearchRow } from "./searchKit";
import type { SearchRowMenu } from "./useSearchMenus";

export function useSearchGroups({
  libShown,
  libTotal,
  presetResults,
  playlistResults,
  favResults,
  radio,
  radioPending,
  hidden,
  radioDirectory,
  playNode,
  openFavorite,
  openNodeMenu,
  openFavMenu,
  setRowMenu,
}: {
  libShown: MediaNode[];
  libTotal: number;
  presetResults: PresetItem[];
  playlistResults: Playlist[];
  favResults: Favorite[];
  radio: RadioStation[] | null;
  radioPending: boolean;
  hidden: Set<SearchCategoryId>;
  radioDirectory: boolean;
  playNode(node: MediaNode): void;
  openFavorite(f: Favorite): void;
  openNodeMenu(node: MediaNode, e: React.MouseEvent): void;
  openFavMenu(f: Favorite, e: React.MouseEvent): void;
  setRowMenu(menu: SearchRowMenu | null): void;
}): Array<SearchGroup<SearchRow>> {
  const favorites = useStore((s) => s.favorites);
  const presets = useStore((s) => s.presets?.presets ?? null);
  // Over ALL presets, not the filtered results: uniqueness-based matching
  // (duplicate saved queues light only an unambiguous match) must see the
  // same field the Presets screen sees, or a filter can fake uniqueness.
  const litPresets = useLitPresets(presets ?? []);
  const connection = useStore((s) => s.connection);
  const jumpToPlaylist = useStore((s) => s.jumpToPlaylist);
  const connected = connection.phase === "connected";

  /** Hearted, by its copy — null fav (artists, identity-less) = no heart. */
  const refFavorited = (ref: MediaRef): boolean => {
    const fav = refToFavorite(ref);
    return fav != null && isFavorited(fav, favorites);
  };

  const favStationUrls = useMemo(
    () =>
      new Set(favorites.filter((f) => f.kind === "station").map((f) => (f as { url: string }).url)),
    [favorites],
  );

  // Station rows light up like the Radio screen's — same audible-name match,
  // same tuning-in window, from the same shared helpers, so the row for a
  // playing stream can't be lit on one screen and dead on the other.
  const playState = useStore((s) => s.playState);
  const radioPlayingName = playingStationName(playState);
  const { tuningUrl, play: playRadio } = useStationTuning(radioPlayingName);

  // ---- The five categories, as data. Every group renders from this list, so a
  // ---- chip, a count, a cap and a sort can't disagree about what a category is.
  // ---- The ORDER is the NAV RAIL'S: one spatial habit for the whole app, so
  // ---- scanning results reuses the muscle memory the sidebar built. Since the
  // ---- rail became user-reorderable (2026-07-26) that means the USER'S order,
  // ---- read live below — the rationale transfers wholesale, and a rail someone
  // ---- deliberately arranged is a stronger claim on their muscle memory than
  // ---- our default ever was. The literal's own order is now just a starting
  // ---- point for that sort.
  // ---- (Radio used to be kept last, as the group that arrives late. It isn't a
  // ---- rule: if the user puts Radio first, Radio goes first, and its own
  // ---- pending state already handles arriving late.)

  const built: Array<SearchGroup<SearchRow>> = [
    {
      id: "library",
      ...SEARCH_CATEGORIES.library,
      total: libTotal,
      rows: libShown.map((node) => {
        const ref = fromNode(node);
        const fav = refToFavorite(ref);
        return {
          key: `${node.serverUdn}:${node.id}`,
          sortKey: node.title,
          kind: nodeKind(node),
          node: (
            <MediaRow
              title={node.title}
              subtitle={[node.artist, node.serverName].filter(Boolean).join(" — ")}
              artUrl={node.artUrl}
              artistName={nodeKind(node) === "artist" ? node.title : null}
              kind={nodeKind(node)}
              badge={kindLabel(nodeKind(node))}
              duration={nodeKind(node) === "track" ? node.durationSecs : undefined}
              actions={
                <>
                  {/* A container's click OPENS it, so playing needs its own
                      button; a track's click already plays. */}
                  {node.isContainer && nodeKind(node) !== "artist" && (
                    <RowAction
                      icon={Play}
                      label={`Play ${node.title}`}
                      onClick={() => {
                        if (node.serverUdn)
                          void tt.mediaQueueAdd(node.serverUdn, node.id, "PLAY_NOW");
                      }}
                    />
                  )}
                  <RowAction
                    icon={MoreHorizontal}
                    label="More actions"
                    onClick={(e) => openNodeMenu(node, e)}
                  />
                  {fav && (
                    <RowHeart
                      favorited={refFavorited(ref)}
                      held={false}
                      onHeart={() => void toggleFavorite(fav)}
                    />
                  )}
                </>
              }
              onClick={() => playNode(node)}
              onContextMenu={(e) => openNodeMenu(node, e)}
            />
          ),
        };
      }),
    },
    {
      id: "presets",
      ...SEARCH_CATEGORIES.presets,
      total: presetResults.length,
      rows: presetResults.map((p) => ({
        key: String(p.id ?? p.name),
        sortKey: p.name ?? "",
        node: (
          <MediaRow
            title={p.name ?? `Preset ${p.id}`}
            subtitle={p.type}
            artUrl={p.art_url}
            kind="preset"
            badge="Preset"
            meta={p.id != null ? `#${p.id}` : undefined}
            // NOT `p.is_playing` — the device's flag is untrustworthy in both
            // directions; useLitPresets is the one derivation (see its memo).
            playing={p.id != null && litPresets.has(p.id)}
            dimmed={!connected}
            onClick={() => {
              if (p.id != null) void tt.command({ type: "recallPreset", presetId: p.id });
            }}
          />
        ),
      })),
    },
    {
      id: "playlists",
      ...SEARCH_CATEGORIES.playlists,
      total: playlistResults.length,
      rows: playlistResults.map((p) => ({
        key: p.id,
        sortKey: p.name,
        node: (
          <MediaRow
            title={p.name}
            subtitle={`${p.items.length} ${p.items.length === 1 ? "track" : "tracks"}`}
            kind="playlist"
            badge="Playlist"
            // never dimmed: the row's CLICK opens the playlist, which is local
            // and fine offline — only the Play action needs the streamer, and
            // activatePlaylist reports that failure itself
            actions={
              <RowAction
                icon={Play}
                label={`Play ${p.name}`}
                onClick={() => void activatePlaylist(p)}
              />
            }
            onClick={() => jumpToPlaylist(p.id)}
          />
        ),
      })),
    },
    {
      id: "favorites",
      ...SEARCH_CATEGORIES.favorites,
      total: favResults.length,
      rows: favResults.map((f) => ({
        key: favoriteKey(f),
        sortKey: f.kind === "station" ? f.name : f.title,
        node: (
          <MediaRow
            title={f.kind === "station" ? f.name : f.title}
            subtitle={
              f.kind === "station"
                ? "Station"
                : [f.artist, f.kind === "album" ? "Album" : f.album].filter(Boolean).join(" — ")
            }
            artUrl={f.kind === "station" ? f.favicon : f.artUrl}
            kind={f.kind === "station" ? "station" : f.kind}
            badge={f.kind === "station" ? "Station" : f.kind === "album" ? "Album" : "Track"}
            duration={f.kind === "track" ? (f.durationSecs ?? null) : undefined}
            dimmed={!connected}
            actions={
              <>
                {f.kind !== "station" && (
                  <RowAction
                    icon={MoreHorizontal}
                    label="More actions"
                    onClick={(e) => openFavMenu(f, e)}
                  />
                )}
                <RowHeart
                  favorited
                  held={false}
                  onHeart={() => void tt.favoriteRemove(favoriteKey(f))}
                />
              </>
            }
            onClick={() => openFavorite(f)}
            onContextMenu={(e) => openFavMenu(f, e)}
          />
        ),
      })),
    },
  ];

  // The directory setting decides whether this category EXISTS. Pushed after
  // the literal rather than filtered out of it, so "off" leaves no chip, no
  // count and no way to reach radio-browser from this screen at all.
  if (radioDirectory) {
    built.push({
      id: "radio",
      ...SEARCH_CATEGORIES.radio,
      total: radio?.length ?? 0,
      pending: radioPending,
      // Hidden and never asked: we don't KNOW the count, and printing 0 would
      // claim we looked. The chip stays live so it can be switched back on.
      unknown: hidden.has("radio") && radio === null,
      rows: (radio ?? []).map((st) => {
        const playing = radioPlayingName != null && nameKey(st.name) === radioPlayingName;
        const favorited = favStationUrls.has(st.url);
        const heart = (): void =>
          void toggleFavorite({
            kind: "station",
            name: st.name,
            url: st.url,
            favicon: st.favicon,
            radioBrowserUuid: st.uuid !== st.url ? st.uuid : null,
          });
        return {
          key: st.uuid,
          sortKey: st.name,
          node: (
            <StationRow
              station={st}
              playing={playing}
              tuning={!playing && tuningUrl === st.url}
              favorited={favorited}
              onHeart={heart}
              onPlay={() => void playRadio(st)}
              // its heart from the keyboard ("."), whose button the results list keeps out of
              // the Tab order
              onMenu={(e) => {
                e.preventDefault();
                setRowMenu({
                  title: st.name,
                  ...menuAt(e),
                  items: stationMenuItems({ favorited, onHeart: heart }),
                });
              }}
              // no onSave: save-to-preset belongs to the Radio screen, where
              // the panel has room — omitting the prop omits the button
            />
          ),
        };
      }),
    });
  }

  return built;
}
