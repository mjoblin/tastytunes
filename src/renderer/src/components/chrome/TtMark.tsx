import { cx } from "@/lib/format";

/**
 * THE TASTYTUNES MARK, the app icon's "tt" (dev/icon.html): Fraunces at its bold weight, the
 * second t in gold. Drawn where a screen should say what it is (the sleeping screen on another
 * screen, display/PageTransport). Its color comes from `className` (the ink), its size too.
 */
export function TtMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cx("leading-none font-bold tracking-[-0.02em]", className)}
      style={{ fontFamily: '"Fraunces Variable", Georgia, serif' }}
    >
      t<span className="text-gold">t</span>
    </span>
  );
}
