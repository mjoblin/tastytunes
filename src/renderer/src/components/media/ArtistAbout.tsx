import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ArtistInfo } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { HeaderChip } from "@/components/chrome/Chrome";
import { cx } from "@/lib/format";
import { Lru } from "@/lib/lru";

// ONE HOME for an artist's summary block (lifted 2026-10-11 from History › Elsewhere when the
// artist page took the same block): the lookup and its session cache, and the clamped
// Wikipedia extract with "read more" and the two links out, as the Liner notes panel has them.

/** The artist's summary, asked when a row opens and the Artist info setting is
 *  on (the same gate and the same main-process chain as Now Playing's panel;
 *  main caches, this keeps the promise so a reopen is free). */
const aboutCache = new Lru<string, Promise<ArtistInfo | null>>(300);
export function useArtistAbout(
  name: string,
  wanted: boolean,
): { status: "off" | "loading" | "ready" | "none"; info: ArtistInfo | null } {
  const enabled = useStore((s) => s.settings.artistInfo);
  const [got, setGot] = useState<{ name: string; info: ArtistInfo | null } | null>(null);
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
  }, [name, wanted, enabled]);
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
}: {
  name: string;
  /** The artist page: nothing while it loads or when nothing is found (the page's picture and
   *  name already say who it is); History › Elsewhere says both. */
  quiet?: boolean;
}): React.JSX.Element | null {
  const { status, info } = useArtistAbout(name, true);
  const [whole, setWhole] = useState(false);
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
        {info.summary && !whole && clamped && (
          <HeaderChip
            onClick={() => setWhole(true)}
            className="microlabel px-2.5 py-1.5 motion-safe:active:scale-90"
          >
            read more
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
