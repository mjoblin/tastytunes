import { useEffect, useRef } from "react";
import { ListMusic } from "lucide-react";
import { useStore } from "@/store";
import type { Disc } from "@/hooks/useDisc";
import { EmptyState } from "@/components/chrome/EmptyState";
import { HeaderChip, ScreenTitle } from "@/components/chrome/Chrome";
import { MediaArt } from "@/components/media/MediaArt";
import { Eqbars } from "@/components/media/Eqbars";
import { DurationCell } from "@/components/media/DurationCell";
import { cx, fmtTime } from "@/lib/format";
import { scrollToVisible } from "@/lib/scroll";

/** "10 tracks · 37:39", as the Queue screen's header counts its own. */
export const discFacts = (disc: Pick<Disc, "rows" | "secs">): string =>
  [
    disc.rows.length > 0 && `${disc.rows.length} ${disc.rows.length === 1 ? "track" : "tracks"}`,
    disc.secs != null && fmtTime(disc.secs),
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * The Queue screen while the CD is the source (0.10.0, GitHub issue #1): the disc's tracks,
 * READ-ONLY FOR NOW (user, 2026-09-26). The streamer takes next, previous and seek on a disc and
 * never a track by number, so a row is not a button: no play, no drag, no remove, no
 * selection. The Media Library's own queue is parked, not gone, and one click away.
 */
export function DiscQueue({
  disc,
  parkedCount,
  onShowQueue,
}: {
  disc: Disc;
  /** The Media Library queue's length, waiting for the source to come back. */
  parkedCount: number;
  onShowQueue(): void;
}): React.JSX.Element {
  const followQueue = useStore((s) => s.settings.followQueue);
  const currentRow = useRef<HTMLDivElement | null>(null);
  // land on the playing track, and follow it when the Queue follows (the same setting)
  useEffect(() => {
    scrollToVisible(currentRow.current, 8);
  }, []);
  useEffect(() => {
    if (followQueue) scrollToVisible(currentRow.current, 8);
  }, [disc.head, followQueue]);

  const namesNote =
    disc.names === "musicbrainz"
      ? "Track names from MusicBrainz."
      : disc.looking
        ? "Looking up the track names…"
        : disc.lookupsOff
          ? "Track names appear as each track plays. Turn on Artist and album info in Settings to name them all."
          : "Track names appear as each track plays.";

  const header = (
    <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
      <ScreenTitle>Queue</ScreenTitle>
      <span className="font-mono text-[11px] text-faint">{discFacts(disc)}</span>
      <div className="flex-1" />
      {parkedCount > 0 && (
        <HeaderChip
          data-disc-show-queue
          onClick={onShowQueue}
          className="no-drag flex items-center gap-1.5 px-2.5 py-1.5 text-[12px]"
        >
          <ListMusic size={14} />
          Media Library queue
        </HeaderChip>
      )}
    </header>
  );

  if (disc.rows.length === 0) {
    return (
      <div className="h-full flex flex-col" data-disc-queue>
        {header}
        <EmptyState
          icon={ListMusic}
          title="No disc details yet"
          caption="The CD player hasn't said what's on the disc. Its tracks show here once it does."
        />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" data-disc-queue>
      {header}
      <div className="flex-1 overflow-y-auto px-6 pt-1 pb-6">
        <div className="flex items-center gap-4 px-2 pb-4">
          <div className="h-24 w-24 shrink-0">
            <MediaArt src={disc.artUrl} kind="album" size="card" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="microlabel">CD</div>
            <div className="text-[18px] font-semibold leading-tight text-ink truncate">
              {disc.album ?? "Disc"}
            </div>
            {disc.artist && <div className="text-[13px] text-dim truncate">{disc.artist}</div>}
            <div className="text-[12px] text-faint" data-disc-names={disc.names}>
              {namesNote}
            </div>
          </div>
        </div>

        <div className="divide-y divide-edge/50">
          {disc.rows.map((row, i) => {
            const current = disc.head === i;
            return (
              <div
                key={row.n}
                ref={current ? currentRow : undefined}
                data-disc-row={row.n}
                data-disc-current={current || undefined}
                className={cx(
                  "grid grid-cols-[26px_1fr_auto] items-center gap-3 rounded-lg px-2 py-2 cursor-default",
                  current && "row-playing bg-gold/10",
                )}
              >
                <span className="flex justify-center font-mono text-[10.5px] text-faint tabular-nums">
                  {current ? <Eqbars /> : row.n}
                </span>
                <div
                  className={cx(
                    "min-w-0 truncate text-[13.5px]",
                    current ? "text-gold" : row.title ? "text-ink" : "text-faint",
                  )}
                >
                  {row.title ?? `Track ${row.n}`}
                </div>
                <DurationCell secs={row.secs} />
              </div>
            );
          })}
        </div>

        <p className="px-2 pt-5 text-[12px] text-faint">
          {parkedCount > 0
            ? `Your Media Library queue (${parkedCount} ${parkedCount === 1 ? "track" : "tracks"}) waits where you left it.`
            : "The disc plays from the CD player, so its tracks can't be reordered or queued from here."}
        </p>
      </div>
    </div>
  );
}
