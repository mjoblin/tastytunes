import { useMemo } from "react";
import type { MediaIndexPools, MediaNode } from "@shared/model";
import {
  FACT_SEP,
  albumFormat,
  albumTracksOf,
  isCompilation,
  nameSortKey,
  trackArtists,
} from "@shared/model";
import { decadeOptionsOf, formatTags, genreOptionsOf, lc, nodeKey } from "./lensShared";

/** A lens artist: content identity, every album they own and every track they perform. */
export interface LensArtist {
  key: string;
  name: string;
  /** The server's own artist picture, else an album's (the row's picture without a photo). */
  artUrl: string | null;
  /** The server's own artist picture alone: a known photo outranks an album's cover, never
   *  the server's (ArtistArt). */
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
   *  same album is in another one too (his ask, 2026-10-22), and its format when another copy of
   *  it is in the same library (his call, 2026-10-24: each copy its own, the card shows the
   *  format), its folder's name when the formats match too. One rule for the Albums lens, the
   *  Artists lens and the artist page. */
  copyBadge(a: MediaNode): string | undefined;
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
    copyBadge(a) {
      const parts: string[] = [];
      if (a.serverName && index.inTwoLibraries(a)) parts.push(a.serverName);
      const twins = (albumsByKey().get(albumKey(a)) ?? []).filter(
        (b) => b !== a && lc(b.artist) === lc(a.artist),
      );
      if (twins.length > 0) {
        const formatOf = (x: MediaNode): string | null => albumFormat(index.tracksOf(x)).label;
        const mine = formatOf(a);
        const folder = a.titlePath?.[a.titlePath.length - 1] ?? null;
        if (mine && twins.every((t) => formatOf(t) !== mine)) parts.push(mine);
        else if (folder && lc(folder) !== lc(a.title)) parts.push(folder);
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
      return lazy("artists", () => {
        const byKey = new Map<string, LensArtist>();
        const ensure = (name: string): LensArtist => {
          const key = lc(name);
          let a = byKey.get(key);
          if (!a) {
            a = { key, name: name.trim(), artUrl: null, albums: [], tracks: [] };
            byKey.set(key, a);
          }
          return a;
        };
        for (const g of pools) {
          for (const e of g.artists) {
            const a = ensure(e.title);
            a.artUrl ??= e.artUrl;
          }
          for (const alb of g.albums) if (alb.artist) ensure(alb.artist).albums.push(alb);
          // Every PERFORMER is an artist, and only performers — never the packed
          // "A; B" string. A featured singer gets a row with their one track;
          // the headliner keeps every track of the album (2026-08-15).
          for (const t of g.tracks) for (const name of trackArtists(t)) ensure(name).tracks.push(t);
        }
        return [...byKey.values()]
          .filter((a) => a.albums.length > 0 || a.tracks.length > 0)
          .map((a) => ({
            ...a,
            ownArt: a.artUrl,
            artUrl: a.artUrl ?? a.albums.find((x) => x.artUrl)?.artUrl ?? null,
            albums: [...a.albums].sort(
              (x, y) =>
                (y.year ?? "").localeCompare(x.year ?? "") || x.title.localeCompare(y.title),
            ),
          }))
          .sort((a, b) => nameSortKey(a.name).localeCompare(nameSortKey(b.name)));
      });
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
