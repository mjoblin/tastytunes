import { useEffect, useRef, useState } from "react";
import { ArtImage } from "@/components/media/ArtImage";
import { useDecodedArt } from "@/hooks/useDecodedArt";

/**
 * Album art that crossfades when the source changes: the incoming image fades
 * in over the outgoing one (kept underneath), which is dropped once the fade
 * finishes — instead of the hard pixel-swap a plain <img> src change gives.
 * A drop-in replacement for <ArtImage> wherever the art can change in place.
 *
 * The swap waits for the incoming image to DECODE, so the fade never reveals a
 * half-loaded box (device-proxied and remote-station art can be slow), and the
 * outgoing layer is dropped on the fade's own animationend rather than a JS
 * timer mirroring the CSS duration (.art-fade-in owns that number).
 */
export function CrossfadeArt({
  src,
  className,
  fallback,
}: {
  src: string | null | undefined;
  className: string;
  fallback: React.ReactNode;
}): React.JSX.Element {
  const [cur, setCur] = useState<{ src: string | null | undefined; k: number }>({ src, k: 0 });
  const [prev, setPrev] = useState<{ src: string | null | undefined; k: number } | null>(null);
  const curRef = useRef(cur);
  const kRef = useRef(0);
  const { pending } = useDecodedArt(src);
  useEffect(() => {
    if (pending) return; // hold the outgoing art until the incoming one is decoded
    if (src === curRef.current.src) return;
    setPrev(curRef.current);
    const next = { src, k: ++kRef.current };
    curRef.current = next;
    setCur(next);
  }, [src, pending]);
  return (
    <div className="relative">
      {prev && (
        <div key={`p${prev.k}`} className="absolute inset-0">
          <ArtImage src={prev.src} className={className} fallback={fallback} />
        </div>
      )}
      <div
        key={`c${cur.k}`}
        className="art-fade-in"
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) setPrev(null);
        }}
      >
        <ArtImage src={cur.src} className={className} fallback={fallback} />
      </div>
    </div>
  );
}
