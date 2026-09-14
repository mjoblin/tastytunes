import { Disc3, Heart, MoreHorizontal, Play } from "lucide-react";
import { albumFormatChips, FACT_SEP } from "@/lib/mediaFacts";
import { cx, fmtAgo } from "@/lib/format";
import { useStore } from "@/store";
import { artSrc, artKeyOf } from "@/lib/artSrc";
import type { MediaNode } from "@shared/model";
import { ArtImage } from "@/components/media/ArtImage";
import { NameLink } from "@/components/media/NameLine";
import { DrChip, LufsChip } from "@/components/media/Waveform";
import { HeaderChip } from "@/components/chrome/Chrome";
import { Segmented } from "@/components/controls/Segmented";
import type { useLibraryFavorites } from "@/components/library/useLibraryFavorites";
import type { useLibraryMenus } from "@/components/library/useLibraryMenus";

// The Library's ALBUM HEADER and the box set's volume pills, lifted out of
// LibraryScreen's render (2026-09-13, the fifth lift's second part): the art,
// the title and artist link, the facts line with last played and the queue,
// the format chips with the DR and loudness (or the sweep's pulse), the
// composer credit, the Play, heart and ⋯ verbs, and the pills that switch a
// set's volumes. The screen derives every fact and hands it in; the header
// only shows.

type Fav = ReturnType<typeof useLibraryFavorites>;
type Men = ReturnType<typeof useLibraryMenus>;
type Store = ReturnType<typeof useStore.getState>;

export function AlbumHeader(
  p: Pick<Fav, "nodeFavorited" | "heartNode"> &
    Pick<Men, "openMenu"> & {
      albumNode: MediaNode;
      albumArt: string | null;
      albumArtist: string | null;
      albumFacts: string | null;
      albumLastPlayed: number | null;
      jumpToHistory: Store["jumpToHistory"];
      albumInQueue: boolean;
      allTracks: MediaNode[];
      albumDrShown: number | null;
      albumLufsShown: number | null;
      albumSweeping: boolean;
      analysisProgress: Store["analysisProgress"];
      albumComposerLine: string | null;
      playContainer(node: MediaNode, el: HTMLElement | null): Promise<void>;
      goToArtistFromLens(node: MediaNode): void;
      /** The browsed album's volume siblings, by volume; null outside a set. */
      setSiblings: MediaNode[] | null;
      volumeMarker(title: string): string;
      openVolume(a: MediaNode): void;
    },
): React.JSX.Element {
  const {
    albumNode,
    albumArt,
    albumArtist,
    albumFacts,
    albumLastPlayed,
    jumpToHistory,
    albumInQueue,
    allTracks,
    albumDrShown,
    albumLufsShown,
    albumSweeping,
    analysisProgress,
    albumComposerLine,
    playContainer,
    nodeFavorited,
    heartNode,
    openMenu,
    goToArtistFromLens,
    setSiblings,
    volumeMarker,
    openVolume,
  } = p;
  return (
    <>
      <div className="flex items-start gap-6 pb-6 pt-2" data-album-header>
        {/* keyed by the album's content like its card, so the thumb the card's fetch made
            is the one drawn here (a click used to fetch the origin again and show blank
            while it did, 2026-09-14); the well is positioned for the pending line, and
            takes the cards' veil rather than the row thumbs' raised ground so the album's
            well matches the card it was clicked from (user, 2026-09-14) */}
        <div className="relative h-[160px] w-[160px] shrink-0 rounded-xl overflow-hidden ring-1 ring-edge bg-veil flex items-center justify-center">
          <ArtImage
            src={artSrc(albumArt, 160, artKeyOf(albumNode))}
            fallbackArt={{ artist: albumArtist, album: albumNode.title }}
            className="h-full w-full object-cover"
            shimmer
            fallback={<Disc3 size={48} strokeWidth={1} className="text-faint" />}
          />
        </div>
        {/* the text column is at least the art's height with the verb row
                pinned to its bottom: a header without a composer line is
                exactly the art's height on every album (the track list starts
                at one place), the verbs sit on the art's bottom edge, and only
                a composer line or a wrapped title grows the header (user call,
                2026-09-05, measured: 153px of 160 without, ~180 with). */}
        <div className="min-w-0 pt-1 flex min-h-[160px] flex-col gap-1.5">
          {/* title + artist are one thought — set tight */}
          <div className="space-y-0.5">
            <div className="font-display font-bold text-[24px] tracking-tight leading-tight">
              {albumNode.title}
            </div>
            {albumArtist &&
              (albumNode.artist ? (
                <NameLink
                  kind="artist"
                  name={albumNode.artist}
                  onGo={() => goToArtistFromLens(albumNode)}
                  data-album-artist-link
                  className="block max-w-full text-left text-[14px] text-dim truncate hover:text-ink hover:underline underline-offset-2"
                >
                  {albumArtist}
                </NameLink>
              ) : (
                <div className="text-[14px] text-dim truncate">{albumArtist}</div>
              ))}
          </div>
          {/* facts + composers are one thought too, set tight (the
                  composer line is only there when every track agrees) */}
          <div className="space-y-0.5">
            {(albumFacts || albumLastPlayed != null || albumInQueue) && (
              <div className="text-[12.5px] text-faint" data-album-facts>
                {albumFacts}
                {albumLastPlayed != null && (
                  <>
                    {albumFacts && FACT_SEP}
                    <button
                      data-album-last-played
                      data-tip="Show in History"
                      onClick={() => jumpToHistory(albumLastPlayed)}
                      className="tip-bottom hover:text-ink hover:underline underline-offset-2 transition-colors"
                    >
                      {`last played ${fmtAgo(albumLastPlayed)}`}
                    </button>
                  </>
                )}
                {albumInQueue && (
                  <>
                    {(albumFacts || albumLastPlayed != null) && FACT_SEP}
                    in the queue
                  </>
                )}
              </div>
            )}
            {/* the format TOKENS as chips, the DR chip (or the sweep's
                    pulse in its place) closing the row — two registers, one
                    home (lib/mediaFacts; user call, 2026-09-01) */}
            {(allTracks.length > 0 || albumDrShown != null || albumSweeping) && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1" data-album-chips>
                {albumFormatChips(allTracks).map((b) => (
                  <span key={b} className="badge">
                    {b}
                  </span>
                ))}
                {albumSweeping ? (
                  // bare text beside padded badges: 6px of its own air on
                  // the left matches a badge's inset, so the word sits as
                  // far from the last chip as chip text sits from chip text
                  <span
                    className="ml-1.5 text-[11.5px] text-faint motion-safe:animate-pulse"
                    data-album-analyzing
                  >
                    analyzing
                    {analysisProgress != null &&
                      analysisProgress.total > 0 &&
                      ` ${analysisProgress.done}/${analysisProgress.total}`}
                    …
                  </span>
                ) : (
                  <>
                    {albumDrShown != null && <DrChip dr={albumDrShown} />}
                    {albumLufsShown != null && <LufsChip lufs={albumLufsShown} />}
                  </>
                )}
              </div>
            )}
            {/* the credit gets 8px of air above (6px here + the group's
                    2px rhythm) so it reads as its own thought (user, 2026-09-05) */}
            {albumComposerLine && (
              <div className="text-[12.5px] text-faint pt-1.5" data-album-composers>
                {albumComposerLine}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 pt-2 mt-auto">
            <button
              data-tip="Replaces the queue"
              // no queue-ack flash on the album screen: the whole-header
              // pulse read as a glitch and even the art square was ruled
              // extra (user, 2026-08-24) — the button's own press state and
              // the playing row lighting up are feedback enough here
              onClick={() => void playContainer(albumNode, null)}
              className="tip-bottom flex items-center gap-2 px-4 py-2 rounded-full bg-amber text-bg text-[13px] font-medium motion-safe:active:scale-95 transition-all"
            >
              <Play size={14} fill="currentColor" /> Play
            </button>
            <button
              data-tip={nodeFavorited(albumNode) ? "Remove from favorites" : "Add to favorites"}
              aria-label={nodeFavorited(albumNode) ? "Remove from favorites" : "Add to favorites"}
              data-album-heart={nodeFavorited(albumNode) ? "on" : "off"}
              onClick={() => heartNode(albumNode)}
              className={cx(
                "tip-bottom p-2 rounded-full ring-1 ring-edge bg-panel/70 transition-all motion-safe:active:scale-90",
                nodeFavorited(albumNode)
                  ? "text-gold hover:text-ink"
                  : "text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70",
              )}
            >
              <Heart size={16} fill={nodeFavorited(albumNode) ? "currentColor" : "none"} />
            </button>
            <HeaderChip
              aria-label="More actions"
              onClick={(e) => openMenu(albumNode, e)}
              shape="full"
              className="p-2"
            >
              <MoreHorizontal size={16} />
            </HeaderChip>
          </div>
        </div>
      </div>
      {/* a box set's volumes as the app's own picker — one pill per volume,
            the open one lit, on its own row above the tracks they switch (the
            app's Segmented-above-its-listing idiom; moved out of the header
            column, which is sized to sit beside the art — user placement,
            2026-08-27). The old faint ‹ › facts line went unnoticed as
            navigation. */}
      {setSiblings && (
        <div className="-mt-1.5 pb-5 flex" data-album-set>
          {/* px-4 pills: a volume row is a few short labels with room to
                spare, so they wear looser padding than the dense partition
                controls (user, 2026-08-27) */}
          <Segmented<string>
            className="[&>button]:px-4"
            value={albumNode.id}
            options={setSiblings.map((a) => ({
              value: a.id,
              label: volumeMarker(a.title),
            }))}
            onChange={(id) => {
              const next = setSiblings.find((a) => a.id === id);
              if (next) openVolume(next);
            }}
          />
        </div>
      )}
    </>
  );
}
