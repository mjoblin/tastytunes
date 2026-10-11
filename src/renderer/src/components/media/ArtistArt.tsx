import { MediaArt, type MediaArtSize } from "@/components/media/MediaArt";
import { useArtistPicture } from "@/lib/artistPictures";

/**
 * An artist's row thumb: the server's picture, else a known photo or a cover from the artist's
 * albums (lib/artistPictures, one batched ask per frame, never a lookup), else the artist icon.
 * For the lists that map their rows inline (the Artists lens, Search), where the hook cannot
 * sit in the map.
 */
export function ArtistArt({
  name,
  src,
  size,
}: {
  name: string;
  src?: string | null;
  size?: MediaArtSize;
}): React.JSX.Element {
  const picture = useArtistPicture(src ? null : name);
  return <MediaArt src={src ?? picture} kind="artist" size={size} />;
}
