import { useMemo } from "react";
import type { MediaIndexPools, MediaNode } from "@shared/model";
import {
  FACT_SEP,
  albumFormat,
  albumTracksOf,
  artistGroups,
  isCompilation,
  nameSortKey,
} from "@shared/model";
import { decadeOptionsOf, formatTags, genreOptionsOf, lc, nodeKey, whichCopy } from "./lensShared";

/** A lens artist: content identity, every album they own and every track they perform. */
export interface LensArtist {
  key: string;
  name: string;
  /** The server's own artist picture, else a cover from their albums or tracks (the row's
   *  picture until main answers). */
  artUrl: string | null;
  /** The server's own artist picture alone, when it is a real one and not a cover (the
   *  artist page's serverArt; ArtistGroup.own, main's rule). */
  ownArt?: string | null;
  albums: MediaNode[];
  tracks: MediaNode[];
}

type Options = ReturnType<typeof genreOptionsOf>;

/**
 * THE LENSES' INDEX (0.11.0 sweep): what the three lenses derive from the pools, made once per
 * pools snapshot (useIndexPools shares one per set of built indexes) instead of in each lens
 * on each mount, where the Albums lens alone grouped every track by album three times. Each
 * field is made on its first read, so a lens pays only for what it shows.
 */
export interface LensIndex {
  albums: MediaNode[];
  tracks: MediaNode[];
  /** The same album (its title and artist) is in more than one library: only then does a card
   *  say which library it is from (his ask, 2026-10-22: with two libraries every card said so). */
  inTwoLibraries(a: Pick<MediaNode, "title" | "albumArtist" | "artist">): boolean;
  /** An album's server and its lowercased title: the albums that share one claim one title. */
  albumKey(a: Pick<MediaNode, "serverUdn" | "title">): string;
  /** One album's own tracks, in disc and position order: its server's tracks of its title, less
   *  another artist's album of the same title, and split from a second copy on the same server
   *  by their pictures (albumTracksOf). THE album's tracks for everything the lenses read over
   *  one: its play tally, its Format tags, whether it is a compilation, the Artists lens's album
   *  column (0.13.0, so two copies and two artists' albums of one title keep their own). */
  tracksOf(a: MediaNode): MediaNode[];
  /** The chip an album's card wears to say WHICH copy it is, or undefined: its library when the
   *  same album is in another one too (his ask, 2026-10-22), and which copy it is when another
   *  copy of it is in the same library (whichCopy: what tells it from the others, else "Copy 2";
   *  0.13.0-rc.4). `formatShown` when the card's format line already says the format. One rule
   *  for the Albums lens, the Artists lens, the artist page and Favorites. */
  copyBadge(a: MediaNode, shown?: { formatShown?: boolean }): string | undefined;
  /** Each album's codec and format tags, by nodeKey: the union over its own tracks. */
  albumCodecs: Map<string, Set<string>>;
  /** The albums that are compilations (by nodeKey). */
  compilationKeys: Set<string>;
  /** Every artist, by name sort key. */
  artists: LensArtist[];
  albumGenres: Options;
  albumDecades: Options;
  trackGenres: Options;
  trackDecades: Options;
}

const albumKey = (a: Pick<MediaNode, "serverUdn" | "title">): string =>
  `${a.serverUdn ?? ""}|${lc(a.title)}`;

/** An album across libraries: its title and artist, whatever server holds it. */
const sameAlbum = (a: Pick<MediaNode, "title" | "albumArtist" | "artist">): string =>
  `${lc(a.title)}|${lc(a.albumArtist ?? a.artist)}`;

function build(pools: MediaIndexPools[]): LensIndex {
  const cache = new Map<string, unknown>();
  const lazy = <T>(name: string, make: () => T): T => {
    if (!cache.has(name)) cache.set(name, make());
    return cache.get(name) as T;
  };
  /** Every track of a title on its server, by albumKey: private, read only by tracksOf, which
   *  says which of them are an album's own (one home for an album's tracks). */
  const tracksByKey = (): Map<string, MediaNode[]> =>
    lazy("tracksByKey", () => {
      const m = new Map<string, MediaNode[]>();
      for (const g of pools)
        for (const t of g.tracks) {
          if (!t.album) continue;
          const k = `${g.udn}|${lc(t.album)}`;
          const list = m.get(k);
          if (list) list.push(t);
          else m.set(k, [t]);
        }
      return m;
    });
  /** The albums by albumKey: a server's albums of one title, two copies among them. */
  const albumsByKey = (): Map<string, MediaNode[]> =>
    lazy("albumsByKey", () => {
      const m = new Map<string, MediaNode[]>();
      for (const alb of index.albums) {
        const k = albumKey(alb);
        const list = m.get(k);
        if (list) list.push(alb);
        else m.set(k, [alb]);
      }
      return m;
    });
  const index: LensIndex = {
    albumKey,
    get albums() {
      return lazy("albums", () => pools.flatMap((g) => g.albums));
    },
    get tracks() {
      return lazy("tracks", () => pools.flatMap((g) => g.tracks));
    },
    inTwoLibraries(a) {
      const libraries = lazy("albumLibraries", () => {
        const m = new Map<string, Set<string>>();
        for (const g of pools)
          for (const alb of g.albums) {
            const k = sameAlbum(alb);
            const set = m.get(k);
            if (set) set.add(g.udn);
            else m.set(k, new Set([g.udn]));
          }
        return m;
      });
      return (libraries.get(sameAlbum(a))?.size ?? 0) > 1;
    },
    tracksOf(a) {
      const memo = lazy("tracksOf", () => new Map<string, MediaNode[]>());
      const id = nodeKey(a);
      let got = memo.get(id);
      if (!got) {
        const k = albumKey(a);
        got = albumTracksOf(a, {
          albums: albumsByKey().get(k) ?? [a],
          tracks: tracksByKey().get(k) ?? [],
        });
        memo.set(id, got);
      }
      return got;
    },
    copyBadge(a, shown) {
      const parts: string[] = [];
      if (a.serverName && index.inTwoLibraries(a)) parts.push(a.serverName);
      const copies = (albumsByKey().get(albumKey(a)) ?? []).filter(
        (b) => lc(b.artist) === lc(a.artist),
      );
      if (copies.some((b) => b !== a)) {
        const formatOf = (x: MediaNode): string | null => albumFormat(index.tracksOf(x)).label;
        parts.push(whichCopy(a, copies, formatOf, shown));
      }
      return parts.length > 0 ? parts.join(FACT_SEP) : undefined;
    },
    get albumCodecs() {
      return lazy("albumCodecs", () => {
        const m = new Map<string, Set<string>>();
        for (const a of index.albums) {
          const set = new Set<string>();
          for (const t of index.tracksOf(a)) for (const tag of formatTags(t.format)) set.add(tag);
          if (set.size > 0) m.set(nodeKey(a), set);
        }
        return m;
      });
    },
    get compilationKeys() {
      return lazy("compilationKeys", () => {
        const keys = new Set<string>();
        for (const a of index.albums) if (isCompilation(a, index.tracksOf(a))) keys.add(nodeKey(a));
        return keys;
      });
    },
    get artists() {
      // THE one grouping (shared/model artistGroups), main's too: every PERFORMER is an artist,
      // never the packed "A; B" string (a featured singer gets a row with their one track, the
      // headliner keeps every track of the album, 2026-08-15), and a server picture that is a
      // cover is no artist's own
      return lazy("artists", () =>
        [...artistGroups(pools).values()]
          .filter((a) => a.albums.length > 0 || a.tracks.length > 0)
          .map((a) => ({
            key: a.key,
            name: a.name,
            ownArt: a.own,
            artUrl: a.own ?? a.cover,
            tracks: a.tracks,
            albums: [...a.albums].sort(
              (x, y) =>
                (y.year ?? "").localeCompare(x.year ?? "") || x.title.localeCompare(y.title),
            ),
          }))
          .sort((a, b) => nameSortKey(a.name).localeCompare(nameSortKey(b.name))),
      );
    },
    get albumGenres() {
      return lazy("albumGenres", () => genreOptionsOf(index.albums));
    },
    get albumDecades() {
      return lazy("albumDecades", () => decadeOptionsOf(index.albums));
    },
    get trackGenres() {
      return lazy("trackGenres", () => genreOptionsOf(index.tracks));
    },
    get trackDecades() {
      return lazy("trackDecades", () => decadeOptionsOf(index.tracks));
    },
  };
  return index;
}

const built = new WeakMap<MediaIndexPools[], LensIndex>();

/** The index for a pools snapshot, made once per snapshot for the session. */
export function lensIndexOf(pools: MediaIndexPools[]): LensIndex {
  let index = built.get(pools);
  if (!index) {
    index = build(pools);
    built.set(pools, index);
  }
  return index;
}

export function useLensIndex(pools: MediaIndexPools[]): LensIndex {
  return useMemo(() => lensIndexOf(pools), [pools]);
}
