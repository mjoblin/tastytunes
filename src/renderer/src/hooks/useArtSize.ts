import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@/store";
import { useDragExtent } from "./useDragExtent";

/** The smallest art: two chips and a grip still usable on it. */
const MIN_PX = 160;
/** What the text column keeps beside the art, and the gap between them (gap-8). */
const TEXT_MIN_PX = 320;
const GAP_PX = 32;

/** The automatic size: three tiers by window width, at Tailwind's lg and xl breakpoints
 *  (compact windows get genuinely small art, the user's pass). */
export const artTier = (windowWidth: number): number =>
  windowWidth >= 1280 ? 400 : windowWidth >= 1024 ? 340 : 260;

/**
 * The Now Playing art's size (the user, 2026-09-12: a handle at the corner, the size
 * remembered). The drag is in pixels, through the drawers' hook, live while dragging and
 * saved on release; what is saved is the size's SHARE of the room the art has, so it
 * survives a window of another size, and null when the drag ends on the detent, the
 * automatic tier, so the old layout comes back exactly. The room is measured from the
 * hero and the waveform under the art with observers, so a window resize re-derives the
 * pixels from the share.
 */
export function useArtSize(mirrored: boolean): {
  size: number;
  dragging: boolean;
  snapped: boolean;
  handleProps: ReturnType<typeof useDragExtent>["handleProps"];
  attachHero(node: HTMLElement | null): void;
  attachWave(node: HTMLElement | null): void;
} {
  const share = useStore((s) => s.settings.nowPlayingArtShare);
  const saveSettings = useStore((s) => s.saveSettings);
  const [room, setRoom] = useState({ w: 0, h: 0, wave: 0 });
  const [win, setWin] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setWin(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const heroObs = useRef<ResizeObserver | null>(null);
  const waveObs = useRef<ResizeObserver | null>(null);
  const attachHero = useCallback((node: HTMLElement | null): void => {
    heroObs.current?.disconnect();
    heroObs.current = null;
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries)
        setRoom((r) => ({ ...r, w: e.contentRect.width, h: e.contentRect.height }));
    });
    ro.observe(node);
    heroObs.current = ro;
  }, []);
  const attachWave = useCallback((node: HTMLElement | null): void => {
    waveObs.current?.disconnect();
    waveObs.current = null;
    if (!node) {
      setRoom((r) => (r.wave === 0 ? r : { ...r, wave: 0 }));
      return;
    }
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setRoom((r) => ({ ...r, wave: e.contentRect.height }));
    });
    ro.observe(node);
    waveObs.current = ro;
  }, []);
  useEffect(
    () => () => {
      heroObs.current?.disconnect();
      waveObs.current?.disconnect();
    },
    [],
  );
  // the room: until the hero is measured (the first paint) the tier stands, unclamped
  const measured = room.h > 0;
  const avail = measured
    ? Math.max(MIN_PX, Math.min(room.h - room.wave, room.w - TEXT_MIN_PX - GAP_PX))
    : Infinity;
  const tier = Math.min(artTier(win), avail);
  const saved =
    share == null || !measured
      ? tier
      : Math.max(MIN_PX, Math.min(avail, Math.round(share * avail)));
  const { size, dragging, snapped, handleProps } = useDragExtent({
    saved,
    save: (px) =>
      saveSettings({
        nowPlayingArtShare: px === tier || !measured ? null : px / avail,
      }),
    detent: tier,
    min: MIN_PX,
    max: () => (measured ? avail : tier),
    axis: "x",
    // the box grows away from the text: rightward, or leftward when the art anchors the right
    grow: mirrored ? -1 : 1,
  });
  return { size, dragging, snapped, handleProps, attachHero, attachWave };
}
