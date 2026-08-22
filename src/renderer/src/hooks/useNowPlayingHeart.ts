import { favoriteKey, type Favorite, type FavoriteMedia } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { toggleFavorite } from "@/lib/favorites";
import { deriveNowPlaying } from "@/lib/format";

export interface NowPlayingHeart {
  /** Already a favorite — the filled state. */
  active: boolean;
  /** There is something hearteable at all; otherwise don't offer the control. */
  available: boolean;
  toggle(): void;
}

/**
 * Content-only favoriting of whatever is playing, shared by every surface that
 * shows a now-playing heart (the Now Playing screen, the tray panel).
 *
 * The rules it encodes, which is why it's a hook and not two copies:
 * - A TRACK needs title + artist. play_state carries no object id for what the
 *   streamer is playing, so the favorite is content-shaped and gets resolved
 *   back to a server when it's acted on.
 * - A STATION needs a URL to replay, and play_state never carries one. So a
 *   stream is hearteable only when TastyTunes started it this session
 *   (`lastStation`) or it's already a favorite — in which case the heart is
 *   there to UN-heart it. That asymmetry is the whole subtlety here.
 */
export function useNowPlayingHeart(): NowPlayingHeart {
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const favorites = useStore((s) => s.favorites);
  const lastStation = useStore((s) => s.lastStation);

  const meta = deriveNowPlaying(playState, nowPlaying);
  const md = playState?.metadata;

  const stationName = meta.isRadio ? ((md?.station ?? md?.name)?.trim() ?? null) : null;
  const stationFav = stationName
    ? (favorites.find(
        (f) => f.kind === "station" && f.name.trim().toLowerCase() === stationName.toLowerCase(),
      ) ?? null)
    : null;
  const lastMatches =
    stationName != null &&
    lastStation != null &&
    lastStation.name.trim().toLowerCase() === stationName.toLowerCase();

  const trackFav: Omit<FavoriteMedia, "addedAt"> | null =
    !meta.isRadio && meta.title && meta.subtitle
      ? {
          kind: "track",
          title: meta.title,
          artist: meta.subtitle,
          album: meta.album ?? null,
          artUrl: meta.artUrl ?? null,
          serverUdn: null,
          serverName: null,
          objectId: null,
          titlePath: null,
          durationSecs: md?.duration ?? null,
        }
      : null;

  return {
    active: trackFav
      ? favorites.some((f) => favoriteKey(f) === favoriteKey(trackFav as Favorite))
      : stationFav != null,
    available: trackFav != null || stationFav != null || lastMatches,
    toggle(): void {
      if (trackFav) void toggleFavorite(trackFav);
      else if (stationFav) void tt.favoriteRemove(favoriteKey(stationFav));
      else if (lastStation && lastMatches)
        void tt.favoriteAdd({
          kind: "station",
          addedAt: Date.now(),
          name: lastStation.name,
          url: lastStation.url,
          favicon: lastStation.favicon,
          radioBrowserUuid: lastStation.radioBrowserUuid,
        });
    },
  };
}
