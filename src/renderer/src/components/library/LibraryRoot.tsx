import { Disc3, HardDrive, Loader2, Music2, Usb, Users } from "lucide-react";
import type { MediaServerInfo } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { cx, fmtCount } from "@/lib/format";
import { FACT_SEP } from "@/lib/mediaFacts";
import type { Lens } from "@/components/library/lensNavigation";
import { useIndexDoors } from "@/components/library/useIndexDoors";
import { useDoorArt } from "@/components/library/useDoorArt";
import { AlbumsArt, ArtistsArt, TracksArt } from "@/components/library/DoorArt";
import { RecentlyAddedShelf } from "@/components/library/RecentlyAddedShelf";

/** The sources' cards: a fixed, compact width (the card-size slider is for art). */
const SOURCE_CARD_PX = 150;

/**
 * The Library's ROOT: the lens doors over every built index, then the sources, grouped
 * like the official app (Servers / USB drives). The doors lead, wide and pictured (0.12.0-rc.3);
 * the sources follow as quiet compact cards with a short well, at the card grids' gap: a
 * source is a place to browse, not a picture, and beside the doors a full-size card with one
 * glyph in it read as the main event. (Split out of LibraryScreen in the 0.11.0 sweep; the
 * screen decides when it shows.)
 */
export function LibraryRoot({
  servers,
  filter,
  openLens,
  enterServer,
}: {
  servers: MediaServerInfo[];
  filter: string;
  openLens: (lens: Lens) => void;
  enterServer: (udn: string) => void;
}): React.JSX.Element {
  const presetGap = useStore((s) => s.settings.presetGap);
  const saveSettings = useStore((s) => s.saveSettings);
  // Standby honesty: USB source cards dim (the streamer's own ContentDirectory
  // has no content until wake — probed 2026-07-23); external servers and the
  // local index browse fine while the device sleeps.
  const inStandby = useStore((s) => s.systemPower != null && s.systemPower.power !== "ON");
  const { mediaIndexStatuses, readyIndexes, buildingCount, failedIndexes, doorsState } =
    useIndexDoors();
  const art = useDoorArt(doorsState === "ready");
  const shownServers = servers;
  return (
    <div className="space-y-7 pt-1">
      {shownServers.length === 0 && (
        <div className="text-[15px] text-faint pt-3 px-1">
          {filter ? `No matches for “${filter}”` : "Nothing here"}
        </div>
      )}
      {/* the lens doors LEAD the root: our views over EVERY built index at once, wide hero
      doors with a picture of each lens from the reader's own library (DoorArt), so they never
      read as one more source beside the streamer's (his ask, 0.12.0-rc.3). No section label:
      each caption already says "every library", and unlabeled they read as the page's lead
      with the sources' labeled sections below (his call, 2026-10-21) */}
      {doorsState !== "hidden" && (
        <div data-library-doors={doorsState} className="lib-doors">
          <div className="lib-doors-row">
            {[
              {
                key: "albums" as const,
                title: "Albums",
                icon: Disc3,
                count: readyIndexes.reduce((acc, x) => acc + x.albums, 0),
                noun: "albums",
              },
              {
                key: "artists" as const,
                title: "Artists",
                icon: Users,
                count: readyIndexes.reduce((acc, x) => acc + x.artists, 0),
                noun: "artists",
              },
              {
                key: "tracks" as const,
                title: "Tracks",
                icon: Music2,
                count: readyIndexes.reduce((acc, x) => acc + x.tracks, 0),
                noun: "tracks",
              },
            ].map((door) => (
              <div
                key={door.key}
                data-library-lens={door.key}
                aria-disabled={doorsState === "building" ? true : undefined}
                data-tip={
                  buildingCount > 0 && doorsState !== "failed"
                    ? `Indexing ${buildingCount === 1 ? "a library" : `${buildingCount} libraries`}…${doorsState === "ready" ? " What is already indexed is browsable now." : ""}`
                    : doorsState === "failed"
                      ? `Couldn't index ${failedIndexes.map((x) => `${x.serverName} (${x.failure ?? "no index"})`).join(", ")}. Click to retry.`
                      : undefined
                }
                onClick={() => {
                  if (doorsState === "building") return;
                  if (doorsState === "failed") {
                    for (const x of failedIndexes) void tt.mediaIndexRebuild(x.udn);
                    return;
                  }
                  openLens(door.key);
                }}
                className={cx(
                  // tip-wide anchors the tooltip to the card's LEFT edge and wraps it:
                  // centered, the indexing tip poked past the scrollport's left
                  // edge and clipped (user, 2026-08-29). Under the cursor the whole door
                  // grows, words and all, as every card does (his ask, 2026-10-21)
                  "lib-door group tip-bottom tip-wide transition-all duration-200 ease-out",
                  doorsState === "building"
                    ? "opacity-60 cursor-default"
                    : "card-hover-glow cursor-pointer hover:z-10 motion-safe:hover:scale-[1.04]",
                )}
              >
                {/* the picture, clipped to the door (the door itself is not clipped: its tip
                hangs below it); the words sit on the door's own surface below it */}
                <div className="lib-door-clip" aria-hidden>
                  {doorsState === "ready" &&
                    art.picks &&
                    (door.key === "albums" ? (
                      <AlbumsArt picks={art.picks} />
                    ) : door.key === "artists" ? (
                      <ArtistsArt picks={art.picks} />
                    ) : (
                      <TracksArt picks={art.picks} waves={art.waves} />
                    ))}
                </div>
                {doorsState === "building" ? (
                  // the boot screen's own loading glyph while the first index builds, in the
                  // middle of a door with nothing to show yet. The icon's pulse read as styling,
                  // not activity (user, 2026-08-29); reduced motion keeps the icon: a frozen
                  // spinner reads as broken.
                  <div className="lib-door-glyph">
                    <Loader2
                      size={40}
                      strokeWidth={1.1}
                      className="spin text-gold/70 motion-reduce:hidden"
                    />
                    <door.icon
                      size={40}
                      strokeWidth={1.1}
                      className="hidden motion-reduce:block text-gold/70"
                    />
                  </div>
                ) : (
                  doorsState === "failed" && (
                    <div className="lib-door-glyph">
                      <door.icon size={40} strokeWidth={1.1} className="text-gold/70" />
                    </div>
                  )
                )}
                {/* the title and its caption, the door's only words (and one block: a reader
                and the suite find the door by them) */}
                <div className="lib-door-text">
                  <div className="lib-door-title">{door.title}</div>
                  {/* the count line fades in when the index lands (motion-safe, the modal's 140ms) — the door itself never moves */}
                  <div
                    key={doorsState === "ready" && buildingCount === 0 ? "ready" : "waiting"}
                    className={cx(
                      "lib-door-caption motion-safe:transition-opacity motion-safe:duration-[140ms]",
                      doorsState === "failed" && "text-alert",
                    )}
                  >
                    <span className="lib-door-caption-text">
                      {doorsState === "building"
                        ? "Indexing…"
                        : doorsState === "failed"
                          ? `Couldn't index${FACT_SEP}Retry`
                          : buildingCount > 0
                            ? door.count > 0
                              ? `${fmtCount(door.count)} ${door.noun}${FACT_SEP}indexing…`
                              : "Indexing…"
                            : door.count > 0
                              ? `${fmtCount(door.count)} ${door.noun}${FACT_SEP}every library`
                              : "Across every library"}
                    </span>
                    {/* what is indexed is open while another library still builds: the
                    spinner says so after the words, in the line that says "indexing…" (in
                    the door's corner it sat on the Tracks door's top row) */}
                    {doorsState === "ready" && buildingCount > 0 && (
                      <Loader2
                        size={12}
                        strokeWidth={2}
                        className="spin text-gold/70 motion-reduce:hidden"
                      />
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* RECENTLY ADDED (0.13.0 round 9, his pick: a shelf under the doors rather than a fourth
      door): the albums known to be recent, its See all the Albums lens in the same order */}
      {doorsState === "ready" && (
        <RecentlyAddedShelf
          seeAll={() => {
            void saveSettings({ lensAlbumsSort: "added", lensAlbumsSortReversed: false });
            openLens("albums");
          }}
        />
      )}
      {(["servers", "usb"] as const).map((kind) => {
        const group = shownServers.filter((s) => (kind === "usb") === s.isStreamer);
        if (group.length === 0) return null;
        return (
          <div key={kind}>
            <div className="microlabel mb-0.5 px-1">
              {kind === "usb" ? "USB drives" : "Servers"}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(auto-fill, ${SOURCE_CARD_PX}px)`,
                gap: presetGap,
                paddingTop: 8,
              }}
            >
              {group.map((s) => {
                // the card carries ITS server's index state (2026-09-14): the
                // doors animate for any build, this says which one, and a
                // stick's first index is a Build ask the Library never offered
                const st = mediaIndexStatuses.find((x) => x.udn === s.udn) ?? null;
                const state = st?.state ?? "none";
                const building = state === "building";
                const failed = state === "failed";
                const unindexed = state === "none" && !s.searchable;
                // the stick's counter moved (a standby renumbers it, so its music may be
                // just as it was) and the app will not walk it unasked
                const stale = st?.stale === true;
                const Icon = s.isStreamer ? Usb : HardDrive;
                return (
                  <div
                    key={s.udn}
                    data-library-source
                    data-library-source-state={state}
                    onClick={() => {
                      if (failed) {
                        void tt.mediaIndexRebuild(s.udn);
                        return;
                      }
                      enterServer(s.udn);
                    }}
                    data-tip={
                      s.isStreamer && inStandby
                        ? "In standby. USB content appears once the streamer wakes."
                        : failed
                          ? `Couldn't index (${st?.failure ?? "no index"}). Click to retry.`
                          : stale
                            ? "The drive may have changed since it was last indexed."
                            : undefined
                    }
                    className={cx(
                      "group relative rounded-2xl p-2 pb-2.5 bg-raised/50 ring-1 ring-edge card-hover-glow cursor-pointer transition-all duration-200 ease-out hover:z-10 motion-safe:hover:scale-[1.04]",
                      s.isStreamer && inStandby && "opacity-50 tip-bottom",
                      building && "opacity-60",
                      failed && "tip-bottom",
                      // the tip explains the caption, so it sits beside the card level
                      // with the caption (user, 2026-10-05: the default put it beside the
                      // card's middle, far from the cursor; under the card a low card's
                      // tip ran into the playback bar)
                      stale && "tip-low",
                    )}
                  >
                    {/* one frame per card: the well is a veil lift with no ring of its own (see LibraryCards) */}
                    <div className="h-[70px] w-full rounded-lg bg-veil flex items-center justify-center">
                      {building ? (
                        <>
                          {/* the doors' loading glyph: a spinner reads as activity where a
                          pulsing icon read as styling; reduced motion keeps the icon */}
                          <Loader2
                            size={28}
                            strokeWidth={1.2}
                            className="spin text-dim motion-reduce:hidden"
                          />
                          <Icon
                            size={28}
                            strokeWidth={1.2}
                            className="hidden motion-reduce:block text-dim"
                          />
                        </>
                      ) : (
                        <Icon
                          size={28}
                          strokeWidth={1.2}
                          className="text-dim group-hover:text-ink transition-colors"
                        />
                      )}
                    </div>
                    <div className="pt-1.5 text-[12.5px] truncate">{s.name}</div>
                    <div
                      data-library-source-caption
                      className={cx("text-[11.5px] truncate", failed ? "text-alert" : "text-faint")}
                    >
                      {building ? (
                        <span className="motion-safe:animate-pulse">Indexing…</span>
                      ) : failed ? (
                        `Couldn't index${FACT_SEP}Retry`
                      ) : state === "ready" && st && stale ? (
                        <button
                          data-library-source-build
                          data-library-source-stale
                          onClick={(e) => {
                            e.stopPropagation();
                            void tt.mediaIndexRebuild(s.udn);
                          }}
                          // the caption's own color, gold only under the cursor: after
                          // a standby the streamer renumbers the drive and this shows
                          // whether or not anything changed, so it offers, never alarms
                          // (user, 2026-10-05)
                          className="hover:text-gold transition-colors"
                        >
                          Check for changes
                        </button>
                      ) : state === "ready" && st ? (
                        `Indexed${FACT_SEP}${fmtCount(st.albums)} ${st.albums === 1 ? "album" : "albums"}`
                      ) : unindexed ? (
                        <button
                          data-library-source-build
                          onClick={(e) => {
                            e.stopPropagation();
                            void tt.mediaIndexRebuild(s.udn);
                          }}
                          className="text-gold/90 hover:text-gold transition-colors"
                        >
                          {s.isStreamer ? "Index this drive" : "Index this server"}
                        </button>
                      ) : (
                        (s.model ?? (s.isStreamer ? "Storage on the streamer" : "Media server"))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
