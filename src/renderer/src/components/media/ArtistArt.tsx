import { MediaArt, type MediaArtSize } from "@/components/media/MediaArt";
import { useArtistPicture } from "@/lib/artistPictures";

/**
 * An artist's row thumb: main's answer (lib/artistPictures, one batched ask per frame, never a
 * lookup: the server's real picture, a known photo, a cover from the artist's albums), else the
 * server's picture as the row has it, else the caller's own cover, else the artist icon.
 * For the lists that map their rows inline (the Artists lens, Search), where the hook cannot
 * sit in the map.
 */
export function ArtistArt({
  name,
  src,
  cover,
  size,
}: {
  name: string;
  src?: string | null;
  cover?: string | null;
  size?: MediaArtSize;
}): React.JSX.Element {
  const picture = useArtistPicture(name);
  return <MediaArt src={picture ?? src ?? cover} kind="artist" size={size} />;
}
