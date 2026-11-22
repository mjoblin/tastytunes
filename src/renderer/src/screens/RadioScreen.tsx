import { useEffect, useMemo, useRef, useState, useEffectEvent } from "react";
import { Heart, RadioTower, RotateCw, Search, X } from "lucide-react";
import type { RadioStation } from "@shared/model";
import type { Favorite } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { toggleFavorite } from "@/lib/favorites";
import { playingStationName, RADIO_DEBOUNCE_MS, stationMenuItems } from "@/lib/radio";
import { useStationTuning } from "@/hooks/useStationTuning";
import { EmptyState } from "@/components/chrome/EmptyState";
import { StationRow } from "@/components/media/StationRow";
import { RowMenu } from "@/components/media/RowMenu";
import { menuAt, openMenuOn } from "@/lib/menuAt";
import { ListKeysContext, useListKeys } from "@/hooks/useListKeys";
import { PresetSavePanel } from "@/components/library/LibraryMenus";
import { PopoverCard } from "@/components/chrome/Overlay";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { cx } from "@/lib/format";
import { ScreenTitle, GAP_WITHIN, pageEdges } from "@/components/chrome/Chrome";
import { PickerPill } from "@/components/controls/PickerPill";
import { FACT_SEP } from "@/lib/mediaFacts";
import { Lru } from "@/lib/lru";
import { nameKey } from "@shared/keys";

/**
 * Internet radio via the radio-browser.info community directory (keyless —
 * lookups run in the main process for the identifying User-Agent and the
 * renderer CSP). Play is device-native: /stream/radio with the station's
 * stream URL, so the streamer does the playing and any controller sees it.
 * Saving uses /zone/save_preset, which snapshots CURRENT playback — that's
 * why the save affordance lives on the playing station's row only.
 */

// Session-scoped like scrollMemory: coming back to the screen restores the
// last search instead of refetching the default rail.
let lastQuery = "";
let lastResults: RadioStation[] | null = null;
let topCache: RadioStation[] | null = null;
let lastCat: string | null = null;
// a category's stations for the session, the last 50 categories (lib/lru)
const catCache = new Lru<string, RadioStation[]>(50);

/**
 * The curated category layer — the airable-style rails the official app gets
 * from its licensed directory, rebuilt on radio-browser tag facets. Each
 * category is any-of its tags, popularity-ranked; curation here keeps the community
 * directory's junk tags out of the UI. TWO PICKERS, ONE CHOICE (0.16.0-rc.8: fifteen
 * chips wrapped onto a second line): the genres and the decades are each a PickerPill,
 * the library lenses' facet grammar, and one category is chosen at a time, so a decade
 * clears the genre and a genre the decade; Favorites stays a chip of its own.
 */
const RADIO_GENRES: Array<{ label: string; tags: string[] }> = [
  { label: "Pop", tags: ["pop"] },
  { label: "Rock", tags: ["rock"] },
  { label: "Jazz", tags: ["jazz"] },
  { label: "Classical", tags: ["classical"] },
  { label: "Dance & Electronic", tags: ["dance", "electronic", "house"] },
  { label: "Talk & News", tags: ["talk", "news"] },
  { label: "Sport", tags: ["sport", "sports"] },
  { label: "Oldies", tags: ["oldies"] },
  { label: "Country", tags: ["country"] },
  { label: "Hip-Hop", tags: ["hip hop", "rap"] },
];
const RADIO_DECADES: Array<{ label: string; tags: string[] }> = [
  { label: "60s", tags: ["60s"] },
  { label: "70s", tags: ["70s"] },
  { label: "80s", tags: ["80s"] },
  { label: "90s", tags: ["90s"] },
];
const RADIO_CATEGORIES = [...RADIO_GENRES, ...RADIO_DECADES];
const asOptions = (cats: Array<{ label: string }>): Array<{ value: string; label: string }> =>
  cats.map((c) => ({ value: c.label, label: c.label }));
const GENRE_OPTIONS = asOptions(RADIO_GENRES);
const DECADE_OPTIONS = asOptions(RADIO_DECADES);
const among = (cats: Array<{ label: string }>, cat: string | null): string | null =>
  cats.some((c) => c.label === cat) ? cat : null;

/** The favorites chip's sentinel "category" — local, never fetched. */
const FAV_CAT = "__favorites__";

/** A favorited station rendered through the normal station-row machinery. */
const favAsStation = (f: Extract<Favorite, { kind: "station" }>): RadioStation => ({
  uuid: f.radioBrowserUuid ?? f.url,
  name: f.name,
  url: f.url,
  favicon: f.favicon,
  homepage: null,
  tags: "",
  country: "",
  codec: "",
  bitrate: 0,
});

export function RadioScreen(): React.JSX.Element {
  const playState = useStore((s) => s.playState);
  const showToast = useStore((s) => s.showToast);
  const favorites = useStore((s) => s.favorites);
  const favStations = useMemo(
    () =>
      favorites.filter((f): f is Extract<Favorite, { kind: "station" }> => f.kind === "station"),
    [favorites],
  );
  const favUrls = useMemo(() => new Set(favStations.map((f) => f.url)), [favStations]);

  const [query, setQuery] = useState(lastQuery);
  const [top, setTop] = useState<RadioStation[] | null>(topCache);
  const [results, setResults] = useState<RadioStation[] | null>(lastQuery ? lastResults : null);
  const [searching, setSearching] = useState(false);
  const [topFailed, setTopFailed] = useState(false);
  const radioDirectory = useStore((s) => s.settings.radioDirectory);
  const jumpToSettingsTab = useStore((s) => s.jumpToSettingsTab);
  const [cat, setCat] = useState<string | null>(lastCat);
  const [catStations, setCatStations] = useState<RadioStation[] | null>(
    lastCat ? (catCache.get(lastCat) ?? null) : null,
  );
  const [catLoading, setCatLoading] = useState(false);
  const [saveFor, setSaveFor] = useState<{ station: RadioStation; x: number; y: number } | null>(
    null,
  );
  const scrollRef = useScrollMemory("radio");
  const [menu, setMenu] = useState<{
    title: string;
    x: number;
    y: number;
    items: Array<{ label: string; run(): void }>;
  } | null>(null);

  // The default rail, fetched once per app session.
  const loadTop = async (): Promise<void> => {
    setTopFailed(false);
    const stations = await tt.radioTop();
    topCache = stations;
    setTop(stations);
    if (stations.length === 0) setTopFailed(true);
  };
  useEffect(() => {
    if (topCache == null) void loadTop();
  }, []);

  // Category selection — mutually exclusive with search; results cached per
  // category for the session so hopping between categories is instant.
  const catSeq = useRef(0);
  const loadCat = (label: string): void => {
    const seq = catSeq.current;
    setCatLoading(true);
    const def = RADIO_CATEGORIES.find((c) => c.label === label);
    void tt.radioByTags(def?.tags ?? []).then((stations) => {
      // an empty answer is indistinguishable from a directory hiccup — don't
      // cache it, so choosing it again retries
      if (stations.length > 0) catCache.set(label, stations);
      if (seq !== catSeq.current) return; // selection moved on
      setCatStations(stations);
      setCatLoading(false);
    });
  };
  const chooseCat = (next: string | null): void => {
    catSeq.current++;
    setCat(next);
    lastCat = next;
    setQuery("");
    if (!next || next === FAV_CAT) {
      // favorites are local store state — nothing to fetch or cache
      setCatStations(null);
      setCatLoading(false);
      return;
    }
    const cached = catCache.get(next);
    setCatStations(cached ?? null);
    if (!cached) loadCat(next);
  };
  const pickCat = (label: string): void => chooseCat(cat === label ? null : label);
  // Restore path: screen remounts with a category chosen but nothing cached
  // (e.g. its earlier load came back empty) — fetch again.
  const restoreCategory = useEffectEvent(() => {
    if (cat != null && cat !== FAV_CAT && catStations == null) {
      catSeq.current++;
      loadCat(cat);
    }
    // mount-only
  });
  useEffect(() => restoreCategory(), []);
  const dropCat = (): void => {
    if (cat == null) return;
    catSeq.current++;
    setCat(null);
    lastCat = null;
    setCatStations(null);
    setCatLoading(false);
  };

  // Debounced live search; empty query falls back to the rail.
  const searchSeq = useRef(0);
  useEffect(() => {
    lastQuery = query;
    const q = query.trim();
    if (!q) {
      lastResults = null;
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const stations = await tt.radioSearch(q);
          if (seq !== searchSeq.current) return; // superseded by newer keystrokes
          lastResults = stations;
          setResults(stations);
        } catch {
          // the directory didn't answer: keep what was shown, stop searching
          if (seq !== searchSeq.current) return;
        }
        if (seq === searchSeq.current) setSearching(false);
      })();
    }, RADIO_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // What's audible and what's on its way both live in shared helpers now
  // (playingStationName, useStationTuning) — unified search lights the same
  // rows the same way, from the same code.
  const playingName = playingStationName(playState);
  const { tuningUrl, play } = useStationTuning(playingName);

  const savePlaying = async (slot: number, name: string | null): Promise<void> => {
    await tt.command({ type: "zoneSavePreset", slot });
    if (name) await tt.command({ type: "presetRename", slot, name });
    const station = saveFor?.station;
    setSaveFor(null);
    showToast({
      kind: "success",
      text: `Saved “${name ?? station?.name ?? "station"}” to preset ${slot}`,
      action: { label: "View", screen: "presets" },
    });
  };

  const shown =
    results ?? (cat === FAV_CAT ? favStations.map(favAsStation) : cat != null ? catStations : top);
  // FROM THE KEYBOARD (0.14.0): the stations one Tab stop, Enter plays one as its
  // click does, "." its More menu (its heart, and Save to preset on the playing one)
  const keys = useListKeys({
    count: shown?.length ?? 0,
    onEnter: (_i, el) => el?.click(),
    onMenu: (_i, el) => openMenuOn(el),
  });

  const heading =
    results != null
      ? "Search results"
      : cat === FAV_CAT
        ? "Favorites"
        : (cat ?? "Popular stations");

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-3 px-8 pt-8 pb-4">
        <ScreenTitle>Radio</ScreenTitle>
        <div className="flex-1" />
        <div className="no-drag relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value.trim()) dropCat(); // typing takes over from the category
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Search stations"
            aria-label="Search stations"
            className="w-64 bg-bg rounded-lg ring-1 ring-edge focus:ring-edge2 outline-none pl-9 pr-8 py-1.5 text-[13px] placeholder:text-faint"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </header>

      <div className={`px-8 pb-3 flex flex-wrap items-center ${GAP_WITHIN}`}>
        {/* The in-domain view of hearted stations — the union lives on the
            Favorites screen; chip appears once anything is hearted. NOT a
            <Chip>: its unselected skin is gold-tinted (a ring that says "yours"
            before you pick it), which no other chip wants — one site, so it
            stays hand-written rather than becoming a fifth Chip state. */}
        {favStations.length > 0 && (
          <button
            onClick={() => pickCat(FAV_CAT)}
            data-radio-cat="Favorites"
            className={cx(
              "no-drag rounded-full h-8 px-3 text-[12px] ring-1 transition-all motion-safe:active:scale-95 flex items-center gap-1.5",
              cat === FAV_CAT
                ? "ring-accent/50 bg-accentdim text-accent"
                : "ring-accent/30 bg-panel/70 text-accent/80 hover:text-accent hover:ring-accent/50 hover:bg-accentdim/40",
            )}
          >
            <Heart size={11} fill="currentColor" /> Favorites
          </button>
        )}
        {/* data-radio-cat on each picker's holder: the screen's categories, as the chips were */}
        <span data-radio-cat="Genre" className="contents">
          <PickerPill
            id="radio-genre"
            neutral="Genre"
            clearLabel="Any genre"
            options={GENRE_OPTIONS}
            value={among(RADIO_GENRES, cat)}
            onChange={chooseCat}
          />
        </span>
        <span data-radio-cat="Decade" className="contents">
          <PickerPill
            id="radio-decade"
            neutral="Decade"
            clearLabel="Any decade"
            options={DECADE_OPTIONS}
            value={among(RADIO_DECADES, cat)}
            onChange={chooseCat}
          />
        </span>
      </div>

      {/* Directory OFF: say so plainly rather than showing an empty screen that
          looks broken. Favorites still work — a favorited station carries its
          own stream URL and never needed the directory. */}
      {!radioDirectory && cat == null ? (
        <EmptyState
          icon={RadioTower}
          title="Station lookups are off"
          caption="TastyTunes isn't contacting the radio directory. Your favorited stations still play. Turn the directory back on in Settings › Connections to search for new ones."
        >
          <button
            onClick={() => jumpToSettingsTab("connections")}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-[12.5px] text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 transition-all"
          >
            Open Settings
          </button>
        </EmptyState>
      ) : shown == null ? (
        topFailed && cat == null ? (
          <EmptyState
            icon={RadioTower}
            title="Station directory unreachable"
            caption="radio-browser.info didn't answer. Check the connection and try again."
          >
            <button
              onClick={() => void loadTop()}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-[12.5px] text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 transition-all"
            >
              <RotateCw size={13} /> Retry
            </button>
          </EmptyState>
        ) : (
          <div className="px-9 pt-4 text-[13px] text-dim motion-safe:animate-pulse">
            Loading stations…
          </div>
        )
      ) : (
        <div ref={scrollRef} className={`flex-1 overflow-y-auto px-8 ${pageEdges()}`}>
          <div className="max-w-2xl">
            <div className="microlabel mb-2 px-1 flex items-center gap-2">
              {heading}
              {searching && <span className="motion-safe:animate-pulse">searching…</span>}
            </div>
            {shown.length === 0 && !searching && !catLoading && (
              <div className="text-[15px] text-faint pt-4 px-1">
                {results != null ? `No stations for “${query}”` : "No stations here right now."}
              </div>
            )}
            <div {...keys.container} aria-label={heading} className="space-y-1.5">
              <ListKeysContext.Provider value={true}>
                {shown.map((st, i) => {
                  const playing = playingName != null && nameKey(st.name) === playingName;
                  const favorited = favUrls.has(st.url);
                  const heart = (): void =>
                    void toggleFavorite({
                      kind: "station",
                      name: st.name,
                      url: st.url,
                      favicon: st.favicon,
                      radioBrowserUuid: st.uuid !== st.url ? st.uuid : null,
                    });
                  return (
                    <StationRow
                      key={st.uuid}
                      item={keys.item(i)}
                      station={st}
                      playing={playing}
                      tuning={!playing && tuningUrl === st.url}
                      favorited={favorited}
                      onHeart={heart}
                      onPlay={() => void play(st)}
                      onSave={(x, y) => setSaveFor({ station: st, x, y })}
                      onMenu={(e) => {
                        e.preventDefault();
                        const at = menuAt(e);
                        setMenu({
                          title: st.name,
                          ...at,
                          items: stationMenuItems({
                            favorited,
                            onHeart: heart,
                            onSave: playing ? () => setSaveFor({ station: st, ...at }) : undefined,
                          }),
                        });
                      }}
                    />
                  );
                })}
              </ListKeysContext.Provider>
            </div>
            <div className="microlabel mt-6 px-1">
              stations from radio-browser.info{FACT_SEP}community directory
            </div>
          </div>
        </div>
      )}

      {menu && (
        <RowMenu
          title={menu.title}
          at={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={menu.items}
        />
      )}
      {saveFor && (
        <SaveStationPopover
          x={saveFor.x}
          y={saveFor.y}
          station={saveFor.station}
          onClose={() => setSaveFor(null)}
          onSave={savePlaying}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- row pieces

/** The shared PresetSavePanel in an anchored popover next to the save button. */
function SaveStationPopover({
  x,
  y,
  station,
  onClose,
  onSave,
}: {
  x: number;
  y: number;
  station: RadioStation;
  onClose(): void;
  onSave(slot: number, name: string | null): Promise<void>;
}): React.JSX.Element {
  return (
    <PopoverCard at={{ x, y }} width="w-[272px]" onClose={onClose} className="p-3">
      <PresetSavePanel
        title={station.name}
        subtitle="Saves what's playing on the streamer"
        onSave={onSave}
      />
    </PopoverCard>
  );
}
