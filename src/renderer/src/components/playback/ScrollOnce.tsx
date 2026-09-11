import { useEffect, useRef, useState } from "react";
import { cx } from "@/lib/format";

/**
 * A line of text that may not fit its column (the tray panel's now-playing
 * lines, 0.8.0, from a user whose station's artist and song "very often" did
 * not fit). It shows its START, and when the text CHANGES, or the pointer
 * arrives, it scrolls ONCE to its end, rests there a beat, and snaps back. A
 * ticker cycles forever and makes you wait for the part you missed; one pass at
 * the moment of change is glanceable and then still. Whenever the line
 * overflows, the full text rides as a tooltip; under reduced motion the tooltip
 * is the whole answer. `wrap` trades the pass for a second line (the song on
 * radio, where the block can afford the height) and keeps the tooltip.
 */
export function ScrollOnce({
  text,
  wrap = false,
  className,
  tipClass = "tip-bottom",
}: {
  text: string;
  /** Two lines instead of one pass; the tooltip still covers what a second line cannot. */
  wrap?: boolean;
  className?: string;
  /** The tooltip's placement classes (the panel's data-tip system). */
  tipClass?: string;
}): React.JSX.Element {
  const clip = useRef<HTMLDivElement | null>(null);
  const inner = useRef<HTMLSpanElement | null>(null);
  const [overflow, setOverflow] = useState(0);
  const running = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measure = (): number => {
    const c = clip.current;
    const i = inner.current;
    if (!c || !i) return 0;
    // a clamped box hides its overflow but still reports it as scroll height; an
    // inline span inside it does not, so the clip is what to read when wrapping
    return wrap
      ? Math.max(0, c.scrollHeight - c.clientHeight)
      : Math.max(0, i.scrollWidth - c.clientWidth);
  };
  const pass = (): void => {
    const i = inner.current;
    const by = measure();
    if (!i || wrap || by <= 0 || running.current) return;
    if (document.documentElement.classList.contains("reduce-motion")) return;
    // read at 25px per 100ms: a long title takes a few seconds, never a crawl
    const ms = Math.min(6000, Math.max(1200, by * 25));
    i.style.transition = `transform ${ms}ms linear`;
    i.style.transform = `translateX(${-by}px)`;
    running.current = setTimeout(() => {
      i.style.transition = "none";
      i.style.transform = "translateX(0)";
      running.current = null;
    }, ms + 900);
  };
  useEffect(() => {
    if (running.current) {
      clearTimeout(running.current);
      running.current = null;
    }
    const i = inner.current;
    if (i) {
      i.style.transition = "none";
      i.style.transform = "translateX(0)";
    }
    // the text landed: measure after layout, then the one pass
    const raf = requestAnimationFrame(() => {
      setOverflow(measure());
      pass();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- text is the trigger; the rest are refs
  }, [text, wrap]);
  useEffect(
    () => () => {
      if (running.current) clearTimeout(running.current);
    },
    [],
  );

  return (
    <div
      // the placement classes live HERE, on the element that carries data-tip: the
      // tooltip's CSS reads them from that element (on the clip inside, they did
      // nothing and the tip fell to the default place, off to the right)
      className={cx("relative min-w-0", overflow > 0 && `${tipClass} tip-wide`, className)}
      data-tip={overflow > 0 ? text : undefined}
      data-scroll-once={overflow > 0 ? "overflows" : "fits"}
      onMouseEnter={pass}
    >
      <div
        ref={clip}
        className={cx(
          "min-w-0 overflow-hidden",
          wrap
            ? "[display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical]"
            : "whitespace-nowrap",
        )}
      >
        <span ref={inner} className={wrap ? undefined : "inline-block will-change-transform"}>
          {text}
        </span>
      </div>
    </div>
  );
}
