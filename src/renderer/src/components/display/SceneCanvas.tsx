import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store";
import { cx } from "@/lib/format";
import type { SceneFeed } from "./feed";
import { makeScene, resolveSettings, sceneDef } from "./scenes";
import { isGlScene, isThreeScene, type SceneId } from "./scenes/types";
import { disposeRenderer, makeRenderer } from "./three";
import { frameDelta } from "./clock";
import { CATHODE_CURVES, CathodeFinish } from "./cathode";
import type * as THREE from "three";

/**
 * One scene, one animation loop. A 2D scene gets a canvas; a GL scene gets
 * a WebGL2 canvas and a 2D overlay above it for text and marks. Sizes to
 * its box, caps the pixel ratio (1.5 full-screen, 1 for the picker's tiles:
 * a 5K display would otherwise paint fourteen million pixels a frame), sits
 * still while the window is hidden, and halves its frame rate under reduced
 * motion. The scene's settings are resolved here from the store and handed
 * to the instance, so a change lands on the next frame. The canvases are
 * the effect's own children, never React's: a canvas that has ever held a
 * WebGL context cannot hand out a 2D one, nor a fresh GL one after
 * loseContext, so a scene switch (seen live 2026-09-06: a blank stage after
 * Dream) and StrictMode's double mount both need fresh elements.
 */
export function SceneCanvas({
  scene,
  feed,
  mini = false,
  words = !mini,
  className,
}: {
  scene: SceneId;
  feed: SceneFeed;
  mini?: boolean;
  /** Whether this canvas draws the lyric: the wall's default, never a thumbnail's, the Now
   *  Playing tile's own switch. Read each frame, so a toggle never rebuilds the scene. */
  words?: boolean;
  className?: string;
}): React.JSX.Element {
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const def = sceneDef(scene);
  const gl = def.kind === "gl" || def.kind === "three";
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const instRef = useRef<ReturnType<typeof makeScene> | null>(null);
  const [failed, setFailed] = useState(false);
  const persisted = useStore((s) => s.settings.displaySceneSettings[scene]);
  const settings = useMemo(() => resolveSettings(def, persisted), [def, persisted]);
  useEffect(() => {
    if (instRef.current) instRef.current.settings = settings;
  }, [settings]);
  // the display-wide finish rides a ref so the loop sees a change on its next frame
  const finish = useStore((s) => s.settings.displayFinish ?? "cathode");
  const curve = useStore((s) => s.settings.displayCathodeCurve ?? "deep");
  const fill = useStore((s) => s.settings.displayCathodeFill ?? false);
  const finishRef = useRef({ finish, curve, fill });
  finishRef.current = { finish, curve, fill };

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    // the canvases are created HERE, not by React: StrictMode mounts an effect
    // twice, and a canvas whose GL context the first cleanup lost can never
    // hand out another (nor a 2D one), so each run gets fresh elements and
    // removes them on the way out
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 block h-full w-full";
    wrap.appendChild(canvas);
    const overlay = gl ? document.createElement("canvas") : null;
    if (overlay) {
      overlay.className = "pointer-events-none absolute inset-0 block h-full w-full";
      wrap.appendChild(overlay);
    }
    const inst = makeScene(scene);
    inst.settings = settings;
    instRef.current = inst;
    setFailed(false);
    let ctx2d: CanvasRenderingContext2D | null = null;
    let glCtx: WebGL2RenderingContext | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let octx: CanvasRenderingContext2D | null = null;
    let cathode: CathodeFinish | null = null;
    let cathodeFailed = false;
    if (isThreeScene(inst)) {
      const r0 = wrap.getBoundingClientRect();
      renderer = makeRenderer(
        canvas,
        Math.min(window.devicePixelRatio || 1, mini ? 1 : 1.5),
        Math.max(1, Math.round(r0.width)),
        Math.max(1, Math.round(r0.height)),
      );
      if (!renderer) {
        setFailed(true);
        return;
      }
      inst.init(renderer, Math.max(1, Math.round(r0.width)), Math.max(1, Math.round(r0.height)));
      octx = overlay?.getContext("2d") ?? null;
    } else if (isGlScene(inst)) {
      glCtx = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false });
      if (!glCtx || !inst.init(glCtx)) {
        setFailed(true);
        return;
      }
      octx = overlay?.getContext("2d") ?? null;
    } else {
      ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
    }
    let w = 0;
    let h = 0;
    let dpr = 1;
    const size = (): void => {
      const r = wrap.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, mini ? 1 : 1.5);
      w = Math.max(1, Math.round(r.width));
      h = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      if (overlay) {
        overlay.width = canvas.width;
        overlay.height = canvas.height;
      }
      if (renderer && isThreeScene(inst)) {
        renderer.setPixelRatio(dpr);
        renderer.setSize(w, h, false);
        inst.resize?.(w, h);
      }
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(wrap);
    let raf = 0;
    let last = 0;
    let lastFrame = 0;
    const loop = (now: number): void => {
      if (document.hidden) {
        // the stage sleeps while the document is hidden: no frame is scheduled, and
        // visibilitychange below wakes it with a fresh clock so the first frame back
        // does not carry the whole absence as its delta
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(loop);
      const reduced = document.documentElement.classList.contains("reduce-motion");
      if (reduced && now - last < 30) return;
      last = now;
      const dt = lastFrame ? frameDelta((now - lastFrame) / 1000) : 0;
      lastFrame = now;
      const f = feed.frame(now, w, h, mini, dt, wordsRef.current);
      if (isThreeScene(inst) && renderer) {
        inst.draw(renderer, f);
        if (octx && inst.overlay) {
          octx.setTransform(dpr, 0, 0, dpr, 0, 0);
          octx.clearRect(0, 0, w, h);
          inst.overlay(octx, f);
        }
      } else if (isGlScene(inst) && glCtx) {
        glCtx.viewport(0, 0, canvas.width, canvas.height);
        inst.draw(glCtx, f);
        if (octx && inst.overlay) {
          octx.setTransform(dpr, 0, 0, dpr, 0, 0);
          octx.clearRect(0, 0, w, h);
          inst.overlay(octx, f);
        }
      } else if (!isGlScene(inst) && !isThreeScene(inst) && ctx2d) {
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        inst.draw(ctx2d, f);
      }
      // THE FINISH: the cathode glass over whatever was just drawn, never on the tiles
      if (!mini && !cathodeFailed && finishRef.current.finish === "cathode") {
        cathode ??= new CathodeFinish(wrap);
        if (cathode.ok)
          cathode.render(
            canvas,
            overlay,
            now / 1000,
            reduced,
            CATHODE_CURVES[finishRef.current.curve] ?? CATHODE_CURVES.deep,
            finishRef.current.fill,
          );
        else {
          cathode.dispose();
          cathode = null;
          cathodeFailed = true;
        }
      } else if (cathode) {
        cathode.dispose();
        cathode = null;
      }
    };
    const onVisibility = (): void => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
        return;
      }
      last = 0;
      lastFrame = 0;
      if (!raf) raf = requestAnimationFrame(loop);
    };
    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
      instRef.current = null;
      // leave the DOM first and lose the contexts a beat LATER: losing a
      // context in the same tick the element leaves the tree has the
      // compositor produce a frame from a backing that no longer exists
      // (Chromium's "non-existent mailbox" errors, seen live 2026-09-06 when
      // the picker closed and its tiles went at once)
      canvas.remove();
      overlay?.remove();
      cathode?.dispose();
      cathode = null;
      setTimeout(() => {
        if (isThreeScene(inst) && renderer) {
          inst.dispose();
          disposeRenderer(renderer);
        }
        if (isGlScene(inst) && glCtx) {
          inst.dispose(glCtx);
          // free the context: a picker full of tiles would otherwise exhaust the browser's dozen
          glCtx.getExtension("WEBGL_lose_context")?.loseContext();
        }
        canvas.width = 0;
        canvas.height = 0;
        if (overlay) {
          overlay.width = 0;
          overlay.height = 0;
        }
      }, 150);
    };
    // settings ride the effect above; the loop reads inst.settings each frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, feed, mini, gl]);

  return (
    <div ref={wrapRef} className={cx("relative block h-full w-full", className)} data-scene={scene}>
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg text-[12px] text-dim">
          {mini ? "Needs WebGL" : "This scene needs WebGL, which this machine could not provide."}
        </div>
      )}
    </div>
  );
}
