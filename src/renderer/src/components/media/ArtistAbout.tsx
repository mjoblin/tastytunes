import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink, RotateCw } from "lucide-react";
import type { ArtistInfo } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { GAP_BETWEEN, GAP_WITHIN, HeaderChip } from "@/components/chrome/Chrome";
import { cx } from "@/lib/format";
import { Lru } from "@/lib/lru";

// ONE HOME for an artist's summary block (lifted 2026-10-11 from History › Elsewhere when the
// artist page took the same block): the lookup and its session cache, and the clamped
// Wikipedia extract with "read more" and the two links out, as the Liner notes panel has them.

/** The artist's summary, asked when a row opens and the Artist info setting is
 *  on (the same gate and the same main-process chain as Now Playing's panel;
 *  main caches, this keeps the promise so a reopen is free). */
const aboutCache = new Lru<string, Promise<ArtistInfo | null>>(300);
/** Every view of an artist hears a refresh of them (the artist page's header and its block). */
const refreshed = new Set<(name: string) => void>();

/**
 * Ask main again past its cache (the artist page's Refresh details, as Now Playing's panel has
 * it; his ask, 2026-10-12: "is there some way to attempt to load artist art again (maybe a
 * wikipedia page has been added since last check)"). An ask that comes back with nothing keeps
 * the answer already held: a refresh never takes away what the page was showing.
 */
export function refreshArtistAbout(name: string): Promise<ArtistInfo | null> {
  const held = aboutCache.get(name) ?? Promise.resolve(null);
  const p = tt
    .fetchArtistInfo(name, true)
    .catch(() => null)
    .then((info) => info ?? held);
  aboutCache.set(name, p);
  for (const r of refreshed) r(name);
  return p;
}

export function useArtistAbout(
  name: string,
  wanted: boolean,
): { status: "off" | "loading" | "ready" | "none"; info: ArtistInfo | null } {
  const enabled = useStore((s) => s.settings.artistInfo);
  const [got, setGot] = useState<{ name: string; info: ArtistInfo | null } | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const hear = (n: string): void => {
      if (n === name) setRound((r) => r + 1);
    };
    refreshed.add(hear);
    return () => {
      refreshed.delete(hear);
    };
  }, [name]);
  useEffect(() => {
    if (!wanted || !enabled) return;
    let live = true;
    let p = aboutCache.get(name);
    if (!p) {
      p = tt.fetchArtistInfo(name).catch(() => null);
      aboutCache.set(name, p);
    }
    void p.then((info) => {
      // THE RENDERER REMEMBERS ANSWERS, MAIN REMEMBERS MISSES: main returns null
      // for a search that never happened (a 503, a timeout) and refuses to
      // cache it, so keeping that null here turned one bad second into
      // "Nothing found" for the session (user, 2026-09-12: Dominic Fike).
      if (info == null) aboutCache.delete(name);
      if (live) setGot({ name, info });
    });
    return () => {
      live = false;
    };
  }, [name, wanted, enabled, round]);
  if (!enabled) return { status: "off", info: null };
  if (!got || got.name !== name) return { status: "loading", info: null };
  return { status: got.info ? "ready" : "none", info: got.info };
}

/** The artist's summary, as Now Playing's context panel has it: the name
 *  MusicBrainz matched, the Wikipedia extract clamped to a few lines until
 *  asked, and the two links out. Nothing at all when the setting is off — the
 *  row's menu still offers Look it up. */
export function ArtistAbout({
  name,
  quiet = false,
  header = false,
}: {
  name: string;
  /** The artist page: nothing while it loads or when nothing is found (the page's picture and
   *  name already say who it is); History › Elsewhere says both. */
  quiet?: boolean;
  /** In the artist page's header: the summary alone, two lines until asked, its read more a
   *  quiet link under the words; the links out sit on the name's line (ArtistLinks). */
  header?: boolean;
}): React.JSX.Element | null {
  const { status, info } = useArtistAbout(name, true);
  // read in full for this artist only: the next artist's summary opens clamped
  const [wholeFor, setWholeFor] = useState<string | null>(null);
  const whole = wholeFor === name;
  // "read more" only when the clamp cuts something (a short summary had one that did nothing)
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const [clamped, setClamped] = useState(false);
  const summary = info?.summary ?? null;
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || whole) return;
    const check = (): void => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [summary, whole]);
  if (status === "off") return null;
  // a toggle (his ask, 2026-10-13: "if i choose read more i can't revert back"): both labels
  // hold one grid cell, the other kept invisible, so it is one width whichever it says
  const labels = (
    <>
      <span className={cx("[grid-area:1/1]", whole && "invisible")}>read more</span>
      <span className={cx("[grid-area:1/1]", !whole && "invisible")}>read less</span>
    </>
  );
  const toggle = (): void => setWholeFor(whole ? null : name);
  if (header) {
    if (status !== "ready" || !info?.summary) return null;
    return (
      <div className="flex flex-col items-start gap-1" data-elsewhere-about="ready">
        <p
          ref={textRef}
          className={cx(
            "text-[13px] leading-relaxed text-dim whitespace-pre-wrap max-w-xl",
            !whole && "line-clamp-2",
          )}
        >
          {info.summary}
        </p>
        {clamped && (
          <button
            onClick={toggle}
            aria-expanded={whole}
            data-artist-read={whole ? "less" : "more"}
            className="grid text-left text-[12px] text-faint hover:text-ink hover:underline underline-offset-2 transition-colors"
          >
            {labels}
          </button>
        )}
      </div>
    );
  }
  if (quiet && (status === "loading" || status === "none" || !info?.summary)) return null;
  if (status === "loading")
    return (
      <div className="px-1 text-[12px] text-faint" data-elsewhere-about="loading">
        Looking up {name}…
      </div>
    );
  if (status === "none" || !info)
    return (
      <div className="px-1 text-[12px] text-faint" data-elsewhere-about="none">
        Nothing found on MusicBrainz for {name}.
      </div>
    );
  return (
    <div className={cx("space-y-2", !quiet && "px-1")} data-elsewhere-about="ready">
      {info.summary ? (
        <p
          ref={textRef}
          className={cx(
            "text-[13px] leading-relaxed text-dim whitespace-pre-wrap max-w-xl",
            !whole && "line-clamp-4",
          )}
        >
          {info.summary}
        </p>
      ) : (
        <p className="text-[12px] text-faint">
          Matched on MusicBrainz, but no Wikipedia summary is linked.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {info.summary && clamped && (
          <HeaderChip
            onClick={toggle}
            aria-expanded={whole}
            data-artist-read={whole ? "less" : "more"}
            className="microlabel grid px-2.5 py-1.5 motion-safe:active:scale-90"
          >
            {labels}
          </HeaderChip>
        )}
        {info.wikipediaUrl && (
          <HeaderChip
            onClick={() => void tt.openExternal(info.wikipediaUrl ?? "")}
            className="microlabel flex items-center gap-1.5 px-2.5 py-1.5 motion-safe:active:scale-90"
          >
            wikipedia <ExternalLink size={10} />
          </HeaderChip>
        )}
        {info.musicbrainzUrl && (
          <HeaderChip
            onClick={() => void tt.openExternal(info.musicbrainzUrl ?? "")}
            className="microlabel flex items-center gap-1.5 px-2.5 py-1.5 motion-safe:active:scale-90"
          >
            musicbrainz <ExternalLink size={10} />
          </HeaderChip>
        )}
      </div>
    </div>
  );
}

/**
 * THE ARTIST PAGE'S LINKS OUT, on the name's line (his idea, 2026-10-13: "what if we moved the
 * buttons to be right-aligned from the artist name. they wouldn't move up/down then, and would
 * leave more room for the text ... icon buttons for musicbrainz and wikipedia"): round icon
 * buttons, the album header's heart and ⋯ shape, Wikipedia and MusicBrainz as monograms (the
 * app's own letters, not the sites' logos) close together, Refresh details a step apart. The
 * refresh is a standing slot (disabled while the first lookup is out), so nothing pops in
 * beside the name; the links join it when the lookup finds them.
 */
export function ArtistLinks({ name }: { name: string }): React.JSX.Element | null {
  const { status, info } = useArtistAbout(name, true);
  const [refreshing, setRefreshing] = useState(false);
  if (status === "off") return null;
  const round = "tip-bottom tip-end grid h-8 w-8 place-items-center motion-safe:active:scale-90";
  return (
    <div className={cx("flex items-center", GAP_BETWEEN)} data-artist-links>
      <div className={cx("flex items-center empty:hidden", GAP_WITHIN)}>
        {info?.wikipediaUrl && (
          <HeaderChip
            shape="full"
            onClick={() => void tt.openExternal(info.wikipediaUrl ?? "")}
            aria-label="Open on Wikipedia"
            data-tip="Open on Wikipedia"
            data-artist-link="wikipedia"
            className={round}
          >
            <span className="font-display text-[15px] font-bold leading-none">W</span>
          </HeaderChip>
        )}
        {info?.musicbrainzUrl && (
          <HeaderChip
            shape="full"
            onClick={() => void tt.openExternal(info.musicbrainzUrl ?? "")}
            aria-label="Open on MusicBrainz"
            data-tip="Open on MusicBrainz"
            data-artist-link="musicbrainz"
            className={round}
          >
            <span className="font-mono text-[10px] font-bold leading-none tracking-tight">MB</span>
          </HeaderChip>
        )}
      </div>
      <HeaderChip
        shape="full"
        onClick={() => {
          setRefreshing(true);
          void refreshArtistAbout(name).finally(() => setRefreshing(false));
        }}
        disabled={refreshing || status === "loading"}
        aria-label="Refresh details"
        data-tip="Refresh details"
        data-artist-refresh
        className={cx(round, "disabled:opacity-60")}
      >
        <RotateCw size={14} className={cx(refreshing && "motion-safe:animate-spin")} />
      </HeaderChip>
    </div>
  );
}
