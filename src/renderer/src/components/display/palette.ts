import { useEffect, useState } from "react";
import { tt } from "@/api";
import type { Rgb, ScenePalette } from "./scenes/types";

/**
 * The scenes' colors: the theme's tokens read off :root (so a scene is at
 * home on the faceplate and on paper alike), plus three accents drawn from
 * the album art through main (a data URL, never a tainted canvas — the
 * useArtAccent precedent). Plain art falls back to the gold's neighbours.
 */
const parseColor = (v: string): Rgb | null => {
  const s = v.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const trip = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(s);
  if (trip) return [Number(trip[1]), Number(trip[2]), Number(trip[3])];
  const fn = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(s);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  return null;
};

export function readTokens(): Omit<ScenePalette, "accent"> {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const get = (name: string, fallback: Rgb): Rgb =>
    parseColor(cs.getPropertyValue(name)) ?? fallback;
  const light = root.classList.contains("light");
  return {
    light,
    bg: get("--color-bg", light ? [242, 238, 230] : [14, 13, 11]),
    ink: get("--color-ink", light ? [36, 29, 18] : [244, 239, 230]),
    dim: get("--color-dim", light ? [95, 87, 73] : [166, 158, 144]),
    faint: get("--color-faint", light ? [115, 108, 92] : [130, 120, 106]),
    gold: get("--gold-rgb", light ? [178, 118, 16] : [240, 168, 72]),
  };
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
function hslToRgb(h: number, s: number, l: number): Rgb {
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
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255].map(Math.round) as Rgb;
}

/** The gold's neighbours: the accents when the art is plain or unknown. */
export function goldAccents(gold: Rgb, light: boolean): Rgb[] {
  const [h, s] = rgbToHsl(gold[0], gold[1], gold[2]);
  const l = light ? 0.42 : 0.6;
  return [
    hslToRgb((h + 0.92) % 1, Math.max(0.45, s * 0.8), l),
    hslToRgb((h + 0.55) % 1, Math.max(0.4, s * 0.7), l * 0.9),
    hslToRgb(h, s, l),
  ];
}

interface ArtColors {
  accent: Rgb[];
  /** The picture's overall hue, set at a wall's depth (dark on the faceplate, pale on paper). */
  tint: Rgb;
}

/** Three vivid hues from the picture, clamped into the theme's readable range, and its cast. */
async function artAccents(dataUrl: string, light: boolean): Promise<ArtColors | null> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const size = 40;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const buckets = 12;
  const acc = Array.from({ length: buckets }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  const all = { w: 0, r: 0, g: 0, b: 0 };
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (data[i + 3] < 200) continue;
    const [h, s, l] = rgbToHsl(r, g, b);
    if (s < 0.18 || l < 0.08 || l > 0.94) continue;
    const w = s * (1 - Math.abs(l - 0.5));
    const k = Math.min(buckets - 1, Math.floor(h * buckets));
    acc[k].w += w;
    acc[k].r += r * w;
    acc[k].g += g * w;
    acc[k].b += b * w;
    all.w += w;
    all.r += r * w;
    all.g += g * w;
    all.b += b * w;
  }
  const ranked = acc
    .map((a, k) => ({ ...a, k }))
    .filter((a) => a.w > 4)
    .sort((a, b) => b.w - a.w)
    .slice(0, 3);
  if (ranked.length === 0) return null;
  const [lMin, lMax] = light ? [0.32, 0.48] : [0.5, 0.7];
  const out = ranked.map((a) => {
    const [h, s, l] = rgbToHsl(a.r / a.w, a.g / a.w, a.b / a.w);
    return hslToRgb(h, Math.min(Math.max(s, 0.45), 0.85), Math.min(Math.max(l, lMin), lMax));
  });
  const [hueAll, satAll] = rgbToHsl(all.r / all.w, all.g / all.w, all.b / all.w);
  const tint = hslToRgb(hueAll, Math.min(Math.max(satAll, 0.4), 0.7), light ? 0.8 : 0.22);
  return { accent: out, tint };
}

const cache = new Map<string, ArtColors | null>();

/** The full palette for the current art and theme, re-read when either changes. */
export function useScenePalette(artUrl: string | null): ScenePalette {
  const [tokens, setTokens] = useState(readTokens);
  const [accent, setAccent] = useState<ArtColors | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    const mo = new MutationObserver(() => setTokens(readTokens()));
    mo.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
    return () => mo.disconnect();
  }, []);
  useEffect(() => {
    if (!artUrl) {
      setAccent(null);
      return;
    }
    const key = `${tokens.light}|${artUrl}`;
    if (cache.has(key)) {
      setAccent(cache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    void (async () => {
      let out: ArtColors | null = null;
      try {
        const art = await tt.fetchArt(artUrl);
        if (art) out = await artAccents(art.dataUrl, tokens.light);
      } catch {
        out = null;
      }
      cache.set(key, out);
      if (cache.size > 60) cache.delete(cache.keys().next().value as string);
      if (!cancelled) setAccent(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [artUrl, tokens.light]);
  const fallback = goldAccents(tokens.gold, tokens.light);
  const acc = accent ? [...accent.accent, ...fallback].slice(0, 3) : fallback;
  return { ...tokens, accent: acc, tint: accent?.tint };
}
