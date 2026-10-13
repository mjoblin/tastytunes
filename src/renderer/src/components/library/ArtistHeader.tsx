import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import type { MediaNode } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { ArtistAbout, useArtistAbout } from "@/components/media/ArtistAbout";
import { HeaderArt } from "@/components/library/HeaderArt";
import { HEADER_ART_PX, useHeaderArtSize } from "@/hooks/useHeaderArtSize";
import { artSrc } from "@/lib/artSrc";
import { wikiThumbAt } from "@shared/artUrl";
import { refreshArtistPicture, useArtistPicture } from "@/lib/artistPictures";
import { fmtCount } from "@/lib/format";
import { FACT_SEP } from "@/lib/mediaFacts";

/**
 * THE ARTIST PAGE'S HEADER (0.11.0, a user's email: "Would it be possible for TastyTunes to
 * scrape artist image and display it instead of the grey square with disc image?"), shaped like
 * the album header (user, 2026-10-11: "let's make it more consistent with our existing album
 * page"): the picture, and beside it a column at least the default picture's height: the
 * name, the facts line (the Artists lens's counts, from the indexes), two lines of the
 * artist's Wikipedia summary, and its links pinned to the column's foot where the album
 * header's verbs sit (ArtistAbout, History › Elsewhere's block); "read more" grows the column
 * as a composer line grows the album's. No label: the crumbs, the picture and the name say
 * whose page it is, as an album's do. No verbs: the Library does not play a whole artist.
 * The picture is main's answer for the artist (a real server picture, else the photo, else a
 * cover from their albums: a server picture that is an album's cover counts as a cover), else
 * this lookup's photo, else the server's picture, else a picture from the page's own folders.
 * Its size is dragged from the corner, one size with the album header's (HeaderArt, 0.11.0);
 * a Wikipedia photo is asked for again at the size drawn (wikiThumbAt).
 */
export function ArtistHeader({
  name,
  serverArt,
  folders,
}: {
  name: string;
  /** The server's own picture for the artist, as its folder or the index has it. */
  serverArt?: string | null;
  /** Nodes whose pictures stand in last (the page's folders, or the artist's albums). */
  folders: readonly MediaNode[];
}): React.JSX.Element {
  const lookups = useStore((s) => s.settings.artistInfo);
  const art = useHeaderArtSize("Resize Artist Picture");
  const known = useArtistPicture(name);
  const { info } = useArtistAbout(name, true);
  const photo = lookups ? (info?.image ?? null) : null;
  // the lookup that brought the photo also taught main: the rows (and this page) ask again
  useEffect(() => {
    if (photo) refreshArtistPicture(name);
  }, [photo, name]);
  const [facts, setFacts] = useState<{ of: string; albums: number; tracks: number } | null>(null);
  useEffect(() => {
    let live = true;
    void tt
      .artistFacts(name)
      .then((f) => {
        if (live) setFacts(f ? { of: name, ...f } : null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [name]);
  const factsLine =
    facts && facts.of === name
      ? [
          facts.albums > 0 && `${fmtCount(facts.albums)} album${facts.albums === 1 ? "" : "s"}`,
          facts.tracks > 0 && `${fmtCount(facts.tracks)} track${facts.tracks === 1 ? "" : "s"}`,
        ]
          .filter(Boolean)
          .join(FACT_SEP)
      : "";
  const picture = known ?? photo ?? serverArt ?? folders.find((f) => f.artUrl)?.artUrl ?? null;
  return (
    <div className="flex items-start gap-6 pb-6 pt-2" data-artist-header ref={art.attachRow}>
      <HeaderArt
        art={art}
        label="Resize the artist's picture"
        src={artSrc(picture, HEADER_ART_PX)}
        sharp={
          art.settled > HEADER_ART_PX
            ? artSrc(wikiThumbAt(picture, art.settled) ?? picture, art.settled)
            : null
        }
        fallback={(px) => <UserRound size={px} strokeWidth={1} className="text-faint" />}
      />
      <div className="min-w-0 max-w-2xl pt-1 flex min-h-[160px] flex-col gap-1.5">
        <div className="space-y-0.5">
          <div className="font-display font-bold text-[24px] tracking-tight leading-tight">
            {name}
          </div>
          {factsLine && (
            <div className="text-[12.5px] text-faint" data-artist-facts>
              {factsLine}
            </div>
          )}
        </div>
        <ArtistAbout name={name} quiet header />
      </div>
    </div>
  );
}
