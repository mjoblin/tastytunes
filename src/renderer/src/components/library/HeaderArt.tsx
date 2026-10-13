import { useEffect, useState } from "react";
import { ArtImage, isPortrait, PORTRAIT_POSITION } from "@/components/media/ArtImage";
import { CornerResizeHandle } from "@/components/controls/CornerResizeHandle";
import type { useHeaderArtSize } from "@/hooks/useHeaderArtSize";

/**
 * THE PICTURE IN THE LIBRARY'S ALBUM AND ARTIST HEADERS (0.11.0, when it became resizable):
 * one well for both, as the artist page was shaped like the album page. The well is keyed to
 * the album's content like its card (AlbumHeader's note), takes the cards' veil, and its ring
 * steps up while a picture is pending; the grip sits in its bottom corner, shown on hover, as
 * Now Playing's does.
 * TWO LAYERS once the picture is larger than the default: underneath, the picture at the
 * default size (the thumbnail its card already made, so it is there at once); over it, the
 * picture at the size drawn, laid on only once it has loaded, so a larger size never shows a
 * blank well while the bigger file arrives, and a bigger file that fails leaves the smaller
 * one showing. The larger layer is asked for at the SETTLED size, not on every step of a drag.
 */
export function HeaderArt({
  art,
  label,
  src,
  sharp,
  fallbackArt,
  fallback,
  portraitTop = false,
}: {
  art: Pick<ReturnType<typeof useHeaderArtSize>, "size" | "dragging" | "snapped" | "handleProps">;
  /** The grip's label. */
  label: string;
  /** The picture at the default size. */
  src: string | null;
  /** The picture at the settled size, when that is larger than the default. */
  sharp: string | null;
  fallbackArt?: { artist: string | null | undefined; album: string | null | undefined };
  /** Drawn when there is no picture, at the well's size. */
  fallback(px: number): React.ReactNode;
  /** A portrait picture is cropped from near its top (an artist's photo; ArtImage). */
  portraitTop?: boolean;
}): React.JSX.Element {
  return (
    <div
      data-header-art={art.size}
      style={{ width: art.size, height: art.size }}
      className="group relative shrink-0 rounded-xl overflow-hidden ring-1 ring-edge has-[[data-art-pending]]:ring-edge2 has-[[data-art-pending]]:duration-100 transition-shadow duration-300 bg-veil flex items-center justify-center"
    >
      <ArtImage
        src={src}
        fallbackArt={fallbackArt}
        className="h-full w-full object-cover"
        shimmer
        portraitTop={portraitTop}
        fallback={fallback(Math.round(art.size * 0.3))}
      />
      {/* keyed by the picture, so another album's larger file never lies over this one */}
      {sharp && sharp !== src && (
        <LargerLayer key={src ?? ""} src={sharp} portraitTop={portraitTop} />
      )}
      <CornerResizeHandle
        corner="bottom-right"
        dragging={art.dragging}
        snapped={art.snapped}
        handleProps={art.handleProps}
        label={label}
      />
    </div>
  );
}

/** The larger file, shown once loaded; a new size keeps the last one showing until it lands. */
function LargerLayer({
  src,
  portraitTop,
}: {
  src: string;
  portraitTop: boolean;
}): React.JSX.Element | null {
  const [shown, setShown] = useState<{ src: string; tall: boolean } | null>(null);
  useEffect(() => {
    if (shown?.src === src) return;
    let live = true;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (live) setShown({ src, tall: isPortrait(img.naturalWidth, img.naturalHeight) });
    };
    img.src = src;
    return () => {
      live = false;
      img.onload = null;
    };
  }, [src, shown]);
  if (!shown) return null;
  return (
    <img
      src={shown.src}
      alt=""
      draggable={false}
      style={portraitTop && shown.tall ? { objectPosition: PORTRAIT_POSITION } : undefined}
      data-header-art-larger
      className="pointer-events-none absolute inset-0 h-full w-full object-cover"
    />
  );
}
