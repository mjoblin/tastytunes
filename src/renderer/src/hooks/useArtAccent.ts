import { useEffect } from "react";
import { Lru } from "@/lib/lru";
import { artAccent } from "@/lib/artAccent";
import { fetchArtSoon } from "@/lib/fetchArtSoon";

// Per-album accent: the color of the current art (lib/artAccent) retints the app's
// accent by overriding --accent-rgb on :root. Art is fetched through the main
// process (data URL) so the canvas isn't CORS-tainted.

const cache = new Lru<string, string | null>(80); // theme|artUrl -> "r g b" | null

export function useArtAccent(artUrl: string | null, theme: "dark" | "light" = "dark"): void {
  useEffect(() => {
    const root = document.documentElement;
    const apply = (rgb: string | null): void => {
      if (rgb) root.style.setProperty("--accent-rgb", rgb);
      else root.style.removeProperty("--accent-rgb");
    };

    if (!artUrl) {
      apply(null);
      return;
    }
    const key = `${theme}|${artUrl}`;
    if (cache.has(key)) {
      apply(cache.get(key) ?? null);
      return;
    }

    let cancelled = false;
    void (async () => {
      let rgb: string | null = null;
      // a cover main could not fetch is asked again, and kept as no answer (fetchArtSoon)
      const art = await fetchArtSoon(artUrl, () => !cancelled);
      if (!art) {
        if (!cancelled) apply(null);
        return;
      }
      try {
        rgb = await dominantColor(art.dataUrl, theme);
      } catch {
        rgb = null;
      }
      cache.set(key, rgb);
      if (!cancelled) apply(rgb);
    })();

    return () => {
      cancelled = true;
    };
  }, [artUrl, theme]);
}

/** The cover drawn at 32 × 32, its accent worked out by artAccent. */
async function dominantColor(dataUrl: string, theme: "dark" | "light"): Promise<string | null> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  const rgb = artAccent(ctx.getImageData(0, 0, size, size).data, theme);
  return rgb ? rgb.join(" ") : null;
}
