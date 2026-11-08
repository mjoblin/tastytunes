// THE SEARCH SCREEN'S RESULTS (moved out of SearchScreen.tsx as they were, 0.16.0's tidy): the four
// local groups straight off the store, the library from the indexes, and radio, the one network
// call, each seeded from the session's memory on a return to the same query.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Favorite, MediaNode, Playlist, RadioStation } from "@shared/model";
import type { PresetItem } from "@shared/smoip";
import { tt } from "@/api";
import { useStore } from "@/store";
import { matchesFilter } from "@/lib/format";
import { RADIO_DEBOUNCE_MS } from "@/lib/radio";
import type { SearchCategoryId } from "@/lib/searchGroups";
import { MIN_RADIO_CHARS, searchMemory } from "./searchKit";

export function useSearchResults(
  q: string,
  hidden: Set<SearchCategoryId>,
  radioDirectory: boolean,
): {
  favResults: Favorite[];
  playlistResults: Playlist[];
  presetResults: PresetItem[];
  libResults: MediaNode[];
  libTotal: number;
  radio: RadioStation[] | null;
  radioPending: boolean;
  radioFailed: boolean;
} {
  const favorites = useStore((s) => s.favorites);
  const playlists = useStore((s) => s.playlists);
  const presets = useStore((s) => s.presets?.presets ?? null);

  // ---- local groups: straight off the store, no awaiting anything

  const favResults = useMemo(() => {
    if (!q) return [];
    return favorites.filter((f) =>
      f.kind === "station"
        ? matchesFilter(q, [f.name])
        : matchesFilter(q, [f.title, f.artist, f.album]),
    );
  }, [q, favorites]);

  const playlistResults = useMemo(() => {
    // Name only. Matching a playlist by the tracks INSIDE it sounds helpful and
    // isn't: every playlist holding a common artist would answer every query.
    if (!q) return [];
    return playlists.filter((p) => matchesFilter(q, [p.name]));
  }, [q, playlists]);

  const presetResults = useMemo(() => {
    if (!q) return [];
    return (presets ?? []).filter((p) => p.name && matchesFilter(q, [p.name]));
  }, [q, presets]);

  // ---- library: index-backed, so also instant, but it crosses the IPC bridge

  const [libResults, setLibResults] = useState<MediaNode[]>(() =>
    searchMemory.results?.query === searchMemory.query ? searchMemory.results.lib : [],
  );
  const [libTotal, setLibTotal] = useState(() =>
    searchMemory.results?.query === searchMemory.query ? searchMemory.results.libTotal : 0,
  );
  const libSeq = useRef(0);
  useEffect(() => {
    if (!q) {
      setLibResults([]);
      setLibTotal(0);
      return;
    }
    if (seededQuery.current != null && seededQuery.current !== q) seededQuery.current = null; // a different query lifts the skip
    if (seededQuery.current === q) return; // seeded from memory: nothing to fetch
    const seq = ++libSeq.current;
    void (async () => {
      try {
        const groups = await tt.mediaSearchAll(q);
        if (seq !== libSeq.current) return; // superseded by a newer keystroke
        setLibResults(groups.flatMap((g) => g.items));
        setLibTotal(groups.reduce((n, g) => n + g.total, 0));
      } catch {
        if (seq !== libSeq.current) return;
        setLibResults([]);
        setLibTotal(0);
      }
    })();
  }, [q]);

  // ---- radio: the one network call. Debounced, superseded, and allowed to
  // ---- fail without taking the local groups down with it.

  const [radio, setRadio] = useState<RadioStation[] | null>(() =>
    searchMemory.results?.query === searchMemory.query ? searchMemory.results.radio : null,
  );
  // The query this mount was SEEDED for: its library and radio effects skip
  // the fetch while q is still that query (the rows are already the answer;
  // the radio lookup is a network call and showed as a fresh search on every
  // return — user, 2026-08-23). A different query lifts the skip INSIDE the
  // effects, never in a cleanup: StrictMode's simulated unmount runs every
  // cleanup and re-runs every effect, and a cleanup that nulled this ref made
  // every history return refetch under `npm run dev` (user, 2026-08-23 —
  // "it still takes a second to load more tracks in") while the built app
  // was fine.
  const seededQuery = useRef<string | null>(
    searchMemory.results?.query === searchMemory.query && searchMemory.query
      ? searchMemory.query
      : null,
  );
  useEffect(() => {
    if (q) searchMemory.results = { query: q, lib: libResults, libTotal, radio };
  }, [q, libResults, libTotal, radio]);
  const [radioPending, setRadioPending] = useState(false);
  const [radioFailed, setRadioFailed] = useState(false);
  const radioSeq = useRef(0);
  useEffect(() => {
    // Hidden means DON'T ASK. radio-browser is the only third party this screen
    // touches, and the app promises that a lookup you've turned off makes zero
    // requests — hiding the group while still querying every keystroke would
    // break that quietly. There is no separate "disable radio" setting; this
    // chip is it, and it persists for the session like the rest of the rail.
    if (!radioDirectory || hidden.has("radio") || q.length < MIN_RADIO_CHARS) {
      radioSeq.current++;
      setRadio(null);
      setRadioPending(false);
      setRadioFailed(false);
      return;
    }
    if (seededQuery.current != null && seededQuery.current !== q) seededQuery.current = null; // a different query lifts the skip
    if (seededQuery.current === q) return; // seeded from memory: no lookup, no spinner
    const seq = ++radioSeq.current;
    setRadioPending(true);
    setRadioFailed(false);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const stations = await tt.radioSearch(q);
          if (seq !== radioSeq.current) return;
          setRadio(stations);
        } catch {
          if (seq !== radioSeq.current) return;
          setRadio(null);
          setRadioFailed(true);
        } finally {
          if (seq === radioSeq.current) setRadioPending(false);
        }
      })();
    }, RADIO_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, hidden, radioDirectory]);

  return {
    favResults,
    playlistResults,
    presetResults,
    libResults,
    libTotal,
    radio,
    radioPending,
    radioFailed,
  };
}
