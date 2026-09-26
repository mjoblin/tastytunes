import { useEffect, useRef } from "react";
import { ListMusic } from "lucide-react";
import { useStore } from "@/store";
import type { Disc } from "@/hooks/useDisc";
import { EmptyState } from "@/components/chrome/EmptyState";
import { ScreenTitle } from "@/components/chrome/Chrome";
import { MediaArt } from "@/components/media/MediaArt";
import { Eqbars } from "@/components/media/Eqbars";
import { DurationCell } from "@/components/media/DurationCell";
import { cx, fmtDuration } from "@/lib/format";
import { scrollToVisible } from "@/lib/scroll";

/** "10 tracks · 38 min": a collection's runtime reads in words (the register). */
export const discFacts = (disc: Pick<Disc, "rows" | "secs">): string =>
  [
    disc.rows.length > 0 && `${disc.rows.length} ${disc.rows.length === 1 ? "track" : "tracks"}`,
    disc.secs != null && fmtDuration(disc.secs),
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * The Queue screen while the CD is the source (0.10.0, GitHub issue #1): the disc's tracks,
 * READ-ONLY FOR NOW (user, 2026-09-26). The streamer takes next, previous and seek on a disc and
 * never a track by number, so a row is not a button: no play, no drag, no remove, no
 * selection. The Media Library queue is parked, not gone, and the header's switch is the way
 * to it (a sentence saying so under the list went, user 2026-09-26: the switch says it).
 */
export function DiscQueue({
  disc,
  viewSwitch,
}: {
  disc: Disc;
  /** The CD | Media Library switch, the header's second row in both views. */
  viewSwitch: React.ReactNode;
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

  // a note only when a row can read "Track 4" (user, 2026-09-26): names from MusicBrainz need
  // no credit line, and a lookup on its way lasts a second or two
  const namesNote =
    disc.names === "musicbrainz" || disc.looking
      ? null
      : disc.lookupsOff
        ? "Turn on Liner notes in Settings › Connections to show track names."
        : disc.album
          ? `Couldn't find “${disc.album}” on MusicBrainz.`
          : "Couldn't find this disc on MusicBrainz.";

  const header = (
    <header className="drag-region flex flex-col gap-2 px-8 pt-8 pb-4">
      <div className="flex items-center gap-4">
        <ScreenTitle>Queue</ScreenTitle>
        <span className="min-w-0 truncate whitespace-nowrap font-mono text-[11px] text-faint">
          {discFacts(disc)}
        </span>
      </div>
      {viewSwitch}
    </header>
  );

  if (disc.rows.length === 0) {
    return (
      <div className="h-full flex flex-col" data-disc-queue>
        {header}
        <EmptyState
          icon={ListMusic}
          title="No track list yet"
          caption="Insert a disc, and its tracks appear here once the CD player has read it."
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
          {/* no "CD" label over the album: the switch right above already says it */}
          <div className="min-w-0 space-y-1" data-disc-names={disc.names}>
            <div className="text-[18px] font-semibold leading-tight text-ink truncate">
              {disc.album ?? "Disc"}
            </div>
            {disc.artist && <div className="text-[13px] text-dim truncate">{disc.artist}</div>}
            {namesNote && (
              <div data-disc-note className="text-[12px] text-faint">
                {namesNote}
              </div>
            )}
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
      </div>
    </div>
  );
}
