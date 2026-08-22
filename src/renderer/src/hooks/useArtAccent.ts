import { useEffect } from "react";
import { tt } from "@/api";

// Plexamp-style per-album accent: sample the dominant color of the current art
// and retint the app's amber accent by overriding --amber-rgb on :root. Art is
// fetched through the main process (data URL) so the canvas isn't CORS-tainted.

const cache = new Map<string, string | null>(); // theme|artUrl -> "r g b" | null

export function useArtAccent(artUrl: string | null, theme: "dark" | "light" = "dark"): void {
  useEffect(() => {
    const root = document.documentElement;
    const apply = (rgb: string | null): void => {
      if (rgb) root.style.setProperty("--amber-rgb", rgb);
      else root.style.removeProperty("--amber-rgb");
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
      try {
        const art = await tt.fetchArt(artUrl);
        if (art) rgb = await dominantColor(art.dataUrl, theme);
      } catch {
        rgb = null;
      }
      cache.set(key, rgb);
      if (cache.size > 80) cache.delete(cache.keys().next().value as string);
      if (!cancelled) apply(rgb);
    })();

    return () => {
      cancelled = true;
    };
  }, [artUrl, theme]);
}

/** Saturation-weighted average color, clamped into the theme's accent range. */
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
  const { data } = ctx.getImageData(0, 0, size, size);

  let wr = 0;
  let wg = 0;
  let wb = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 200) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 32 || min > 232) continue; // skip near-black / near-white
    const w = (max - min) / 255 + 0.05; // prefer saturated pixels
    wr += r * w;
    wg += g * w;
    wb += b * w;
    weight += w;
  }
  if (weight < 3) return null; // art is essentially monochrome — keep default amber

  const [h, s, l] = rgbToHsl(wr / weight, wg / weight, wb / weight);
  // Light theme needs a darker accent so tinted text stays readable on paper.
  const [lMin, lMax] = theme === "light" ? [0.34, 0.46] : [0.55, 0.68];
  const [r, g, b] = hslToRgb(
    h,
    Math.min(Math.max(s, 0.5), 0.85),
    Math.min(Math.max(l, lMin), lMax),
  );
  return `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}
