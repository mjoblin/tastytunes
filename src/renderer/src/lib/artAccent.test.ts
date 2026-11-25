/**
 * The accent drawn from album art: a cover with no real color keeps the built accent (a grey's hue
 * is rounding noise), a cover with a little color gets a soft accent of its hue that grows with the
 * color, a colorful cover gives its hue at full strength, and on paper every form of the accent
 * holds its floor whatever the hue.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FULL_CHROMA,
  LIGHT,
  SOFT_SATURATION,
  artAccent,
  contrast,
  holdsOnPaper,
} from "./artAccent";

type Rgb = [number, number, number];

/** A 32 × 32 cover's RGBA pixels: the given ones, then the rest in `fill`. */
function cover(pixels: Rgb[], fill: Rgb = [0, 0, 0]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32 * 32; i++) out.push(...(pixels[i] ?? fill), 255);
  return out;
}
const every = (rgb: Rgb): number[] => cover([], rgb);

/** A fully saturated color at the given hue (degrees). */
function vivid(hue: number): Rgb {
  const f = (n: number): number => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

const hueOf = ([r, g, b]: Rgb): number => {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};

/** HSL saturation (0–1). */
const satOf = ([r, g, b]: Rgb): number => {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (l > 0.5 ? 2 - max - min : max + min);
};

describe("artAccent", () => {
  it("keeps the built accent for a grey cover, in both themes", () => {
    const stone = cover(
      Array.from({ length: 600 }, (_, i): Rgb => [60 + (i % 120), 60 + (i % 120), 60 + (i % 120)]),
    );
    expect(artAccent(stone, "dark")).toBeNull();
    expect(artAccent(stone, "light")).toBeNull();
  });

  it("keeps it for a grey whose channels differ only by compression noise", () => {
    let seed = 7;
    const noise = (): number => ((seed = (seed * 16807) % 2147483647) % 7) - 3;
    const grey = cover(
      Array.from({ length: 1024 }, (_, i): Rgb => {
        const v = 50 + ((i * 37) % 150);
        return [v + noise(), v + noise(), v + noise()];
      }),
    );
    expect(artAccent(grey, "dark")).toBeNull();
  });

  it("gives a grey with a faint cast, a muted sky or stone, a soft accent of its own hue", () => {
    const stone = artAccent(every([112, 104, 100]), "dark");
    expect(stone).not.toBeNull();
    expect(Math.abs(hueOf(stone!) - hueOf([112, 104, 100]))).toBeLessThan(5);
    expect(satOf(stone!)).toBeGreaterThanOrEqual(SOFT_SATURATION.dark - 0.01);
    expect(satOf(stone!)).toBeLessThan(0.4);
  });

  it("grows stronger as the cover's color does, with no jump on the way", () => {
    const sats: number[] = [];
    for (let d = 4; d <= 26; d++) {
      const accent = artAccent(every([128 + d, 128, 128 - d]), "dark");
      expect(accent, `chroma ${(2 * d) / 255}`).not.toBeNull();
      sats.push(satOf(accent!));
    }
    for (let i = 1; i < sats.length; i++) {
      expect(sats[i]).toBeGreaterThanOrEqual(sats[i - 1] - 0.01);
      expect(sats[i] - sats[i - 1]).toBeLessThan(0.06);
    }
    expect(sats[0]).toBeLessThan(SOFT_SATURATION.dark + 0.03);
    const full = artAccent(every([128 + 20, 128, 128 - 20]), "dark")!; // chroma 0.157
    expect((2 * 20) / 255).toBeGreaterThan(FULL_CHROMA);
    expect(satOf(full)).toBeGreaterThanOrEqual(0.49);
  });

  it("keeps a pale cream cover's accent soft, not a loud yellow", () => {
    const cream = artAccent(every([196, 193, 179]), "dark")!;
    expect(satOf(cream)).toBeLessThan(0.45);
  });

  it("keeps it for a black-and-white cover", () => {
    expect(
      artAccent(cover(Array.from({ length: 500 }, (): Rgb => [245, 245, 245])), "dark"),
    ).toBeNull();
  });

  it("takes the hue of a small vivid patch on black", () => {
    const patch = artAccent(cover(Array.from({ length: 24 }, (): Rgb => [220, 30, 30])), "dark");
    expect(patch).not.toBeNull();
    expect(hueOf(patch!)).toBeCloseTo(0, 0);
  });

  it("keeps a colorful cover's hue in both themes", () => {
    for (const theme of ["dark", "light"] as const) {
      const blue = artAccent(every([40, 80, 200]), theme);
      expect(blue).not.toBeNull();
      expect(Math.abs(hueOf(blue!) - hueOf([40, 80, 200]))).toBeLessThan(2);
    }
  });

  it("holds every form's floor on paper at every hue", () => {
    for (let hue = 0; hue < 360; hue += 5) {
      const accent = artAccent(every(vivid(hue)), "light");
      expect(accent, `hue ${hue}`).not.toBeNull();
      expect(holdsOnPaper(accent!), `hue ${hue}`).toBe(true);
      expect(
        contrast(accent!.map((c) => c * LIGHT.ink) as Rgb, LIGHT.raised),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("holds every form's floor on paper for a cover with a little color, at every hue", () => {
    for (let hue = 0; hue < 360; hue += 15) {
      const muted = vivid(hue).map((c) => Math.round(128 + (c - 128) * 0.06)) as Rgb;
      const accent = artAccent(every(muted), "light");
      expect(accent, `hue ${hue}`).not.toBeNull();
      expect(holdsOnPaper(accent!), `hue ${hue}`).toBe(true);
    }
  });

  it("darkens a yellow on paper further than a blue, which already reads", () => {
    const blue = artAccent(every(vivid(220)), "light")!;
    const yellow = artAccent(every(vivid(60)), "light")!;
    expect(holdsOnPaper(blue)).toBe(true);
    expect(Math.max(...yellow)).toBeLessThan(Math.max(...blue));
  });
});

describe("the light theme's numbers", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const light = css.slice(
    css.indexOf(":root.light {"),
    css.indexOf("}", css.indexOf(":root.light {")),
  );
  const hex = (name: string): Rgb => {
    const m = light.match(new RegExp(`${name}:\\s*#([0-9a-f]{6})`, "i"))!;
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as Rgb;
  };
  const mix = (name: string): number =>
    Number(
      light.match(
        new RegExp(
          `${name}:\\s*color-mix\\(in srgb, rgb\\(var\\(--accent-rgb\\)\\) (\\d+)%, black\\)`,
        ),
      )![1],
    ) / 100;

  it("match styles.css", () => {
    expect(LIGHT.paper).toEqual(hex("--color-bg"));
    expect(LIGHT.raised).toEqual(hex("--color-raised"));
    expect(LIGHT.ink).toBe(mix("--color-accentink"));
    expect(LIGHT.inkWash).toBe(mix("--color-accentink-wash"));
    expect(LIGHT.button).toBe(mix("--color-accentbutton"));
    expect(LIGHT.wash).toBe(
      Number(light.match(/--color-accentdim:\s*rgb\(var\(--accent-rgb\) \/ ([\d.]+)\)/)![1]),
    );
  });

  const named = (block: string, name: string): Rgb =>
    block
      .match(new RegExp(`--accent-${name}-rgb:\\s*(\\d+) (\\d+) (\\d+);`))!
      .slice(1)
      .map(Number) as Rgb;

  it("set the soft accent as soft as the default accent, sand, in each theme", () => {
    const dark = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
    expect(Math.abs(satOf(named(dark, "sand")) - SOFT_SATURATION.dark)).toBeLessThan(0.01);
    expect(Math.abs(satOf(named(light, "sand")) - SOFT_SATURATION.light)).toBeLessThan(0.01);
  });

  it("hold every accent choice on paper, the floors each was tuned to", () => {
    for (const name of ["sand", "sage", "teal"]) {
      expect(holdsOnPaper(named(light, name)), name).toBe(true);
    }
  });
});

describe("the accent's choices in styles.css", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const light = css.slice(
    css.indexOf(":root.light {"),
    css.indexOf("}", css.indexOf(":root.light {")),
  );
  const triple = (block: string, name: string): Rgb =>
    block
      .match(new RegExp(`${name}:\\s*(\\d+) (\\d+) (\\d+);`))!
      .slice(1)
      .map(Number) as Rgb;
  const share = (name: string): number =>
    Number(
      light.match(
        new RegExp(
          `${name}:\\s*color-mix\\(in srgb, rgb\\(var\\(--accent-rgb\\)\\) (\\d+)%, black\\)`,
        ),
      )![1],
    ) / 100;
  const hex = (name: string): Rgb => {
    const m = light.match(new RegExp(`${name}:\\s*#([0-9a-f]{6})`, "i"))!;
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as Rgb;
  };

  it("draw Gold from the brand's own gold, and each classed choice from its own color", () => {
    expect(css).toMatch(/--accent-gold-rgb:\s*var\(--gold-rgb\);/);
    for (const name of ["gold", "sage", "teal"]) {
      expect(css, name).toMatch(
        new RegExp(
          `:root\\.accent-choice-${name} \\{\\s*--accent-rgb: var\\(--accent-${name}-rgb\\);\\s*\\}`,
        ),
      );
    }
  });

  it("give Gold on paper the deeper inks of gold's own, within a step", () => {
    const gold = triple(light, "--gold-rgb");
    for (const [mixed, own] of [
      ["--color-accentink", "--color-goldink"],
      ["--color-accentink-wash", "--color-goldink-wash"],
      ["--color-accentbutton", "--color-goldbutton"],
    ]) {
      const ink = gold.map((v) => v * share(mixed));
      hex(own).forEach((v, i) => expect(Math.abs(ink[i] - v), mixed).toBeLessThan(3));
    }
  });
});
