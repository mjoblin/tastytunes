import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import type { MediaNode } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { ArtImage } from "@/components/media/ArtImage";
import { artSrc } from "@/lib/artSrc";
import { noteArtistPicture, useArtistPicture } from "@/lib/artistPictures";

/**
 * THE ARTIST PAGE'S HEADER (0.11.0, a user's email: "Would it be possible for TastyTunes to
 * scrape artist image and display it instead of the grey square with disc image?"): an artist
 * folder opens under its picture and name, the album header's geometry with no verbs (the
 * Library does not play a whole artist). The picture, first found wins: the server's own (a
 * curated one), the artist's photo (their Wikipedia article's lead picture, looked up here
 * when the artist lookups are on, then known to every row), a cover from their albums in the
 * index, a picture from the page's own folders (MinimServer's sub-indexes carry art), the icon.
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
  const [photo, setPhoto] = useState<{ of: string; url: string } | null>(null);
  useEffect(() => {
    if (!lookups) return;
    let live = true;
    void tt
      .fetchArtistInfo(node.title)
      .then((info) => {
        if (!live || !info?.image) return;
        setPhoto({ of: node.title, url: info.image });
        noteArtistPicture(node.title, info.image);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [node.title, lookups]);
  const picture =
    node.artUrl ??
    (lookups && photo?.of === node.title ? photo.url : null) ??
    known ??
    folders.find((f) => f.artUrl)?.artUrl ??
    null;
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
      <div className="min-w-0 pt-1 flex min-h-[160px] flex-col justify-end pb-1">
        <div className="font-display font-bold text-[24px] tracking-tight leading-tight">
          {node.title}
        </div>
      </div>
    </div>
  );
}
