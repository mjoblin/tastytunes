import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import type { MediaNode } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { ArtImage } from "@/components/media/ArtImage";
import { ArtistAbout, useArtistAbout } from "@/components/media/ArtistAbout";
import { artSrc } from "@/lib/artSrc";
import { noteArtistPicture, useArtistPicture } from "@/lib/artistPictures";
import { fmtCount } from "@/lib/format";
import { FACT_SEP } from "@/lib/mediaFacts";

/**
 * THE ARTIST PAGE'S HEADER (0.11.0, a user's email: "Would it be possible for TastyTunes to
 * scrape artist image and display it instead of the grey square with disc image?"; the user,
 * reviewing it: the name sat at the bottom and nothing said this is an artist). The album
 * header's geometry with no verbs (the Library does not play a whole artist): the picture, then
 * a column that reads like the album header's: the "Artist" label, the name, the facts line
 * (the Artists lens's counts, from the indexes), and the artist's Wikipedia summary with its
 * links (ArtistAbout, History › Elsewhere's block). The picture, first found wins: the
 * server's own (a curated one), the artist's photo (the same lookup's lead picture, with Liner
 * notes on, then known to every row), a known photo or a cover from their albums in the index,
 * a picture from the page's own folders (MinimServer's sub-indexes carry art), the icon.
 */
export function ArtistHeader({
  node,
  folders,
}: {
  node: MediaNode;
  folders: readonly MediaNode[];
}): React.JSX.Element {
  const lookups = useStore((s) => s.settings.artistInfo);
  const known = useArtistPicture(node.title);
  const { info } = useArtistAbout(node.title, true);
  const photo = lookups ? (info?.image ?? null) : null;
  useEffect(() => {
    if (photo) noteArtistPicture(node.title, photo);
  }, [photo, node.title]);
  const [facts, setFacts] = useState<{ of: string; albums: number; tracks: number } | null>(null);
  useEffect(() => {
    let live = true;
    void tt
      .artistFacts(node.title)
      .then((f) => {
        if (live) setFacts(f ? { of: node.title, ...f } : null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [node.title]);
  const factsLine =
    facts && facts.of === node.title
      ? [
          facts.albums > 0 && `${fmtCount(facts.albums)} album${facts.albums === 1 ? "" : "s"}`,
          facts.tracks > 0 && `${fmtCount(facts.tracks)} track${facts.tracks === 1 ? "" : "s"}`,
        ]
          .filter(Boolean)
          .join(FACT_SEP)
      : "";
  const picture = node.artUrl ?? photo ?? known ?? folders.find((f) => f.artUrl)?.artUrl ?? null;
  return (
    <div className="flex items-start gap-6 pb-6 pt-2" data-artist-header>
      <div className="relative h-[160px] w-[160px] shrink-0 rounded-xl overflow-hidden ring-1 ring-edge bg-veil flex items-center justify-center">
        <ArtImage
          src={artSrc(picture, 160)}
          className="h-full w-full object-cover"
          shimmer
          fallback={<UserRound size={48} strokeWidth={1} className="text-faint" />}
        />
      </div>
      <div className="min-w-0 max-w-2xl pt-1 flex flex-col gap-3">
        <div className="space-y-0.5">
          <div className="microlabel">Artist</div>
          <div className="font-display font-bold text-[24px] tracking-tight leading-tight">
            {node.title}
          </div>
          {factsLine && (
            <div className="text-[12.5px] text-faint" data-artist-facts>
              {factsLine}
            </div>
          )}
        </div>
        <ArtistAbout name={node.title} quiet />
      </div>
    </div>
  );
}
