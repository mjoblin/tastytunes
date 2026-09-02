import { cx } from "@/lib/format";

/**
 * The chrome kit: the four recipes the app repeats often enough that a drifted
 * copy is a visible bug. NOT a general button system — exactly these four, and
 * each one owns only its SURFACE (ring, fill, text colour, radius, the shared
 * transition). Geometry stays at the call site via `className`, because a
 * header button, a settings-row button and a popover button legitimately differ
 * in padding while wearing the same skin.
 *
 * Nothing here sets padding, and none of the state classes overlap, so a call
 * site's own classes never race the recipe's in the stylesheet.
 */

/**
 * The ringed icon/label button that sits in screen headers, settings rows and
 * side panels — 22 hand-written copies before this.
 *
 * `active` is the follow-toggle skin (auto-follow queue, follow-current preset,
 * an engaged sort): gold ring, gold fill, gold text. A chip that can't be
 * toggled never gets it.
 */
export function HeaderChip({
  active = false,
  shape = "lg",
  className,
  children,
  ...rest
}: {
  active?: boolean;
  /** `full` is for the round album-header buttons; everything else is `lg`. */
  shape?: "lg" | "full";
  className?: string;
  children?: React.ReactNode;
} & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "children"
>): React.JSX.Element {
  return (
    <button
      className={cx(
        shape === "full" ? "rounded-full" : "rounded-lg",
        "ring-1 transition-all",
        active
          ? "ring-gold/50 bg-golddim text-gold"
          : "ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * The h1 every screen opens with. `screen-title` is the display-font opt-out
 * (zoom 1 + a fixed line-height) that keeps every header EXACTLY the same
 * height across the seven display faces — see useDisplayFont. Because that
 * invariant is invisible from a call site, the title is a component so nobody
 * writes the h1 by hand and quietly drops the class.
 */
export function ScreenTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h1 className="font-display screen-title font-bold text-[26px] tracking-tight">{children}</h1>
  );
}

/**
 * The pill chip: search categories, the library lenses' genre/decade rails,
 * radio categories.
 *
 * Four states, each with real sites — `idle` (unselected), `active` (the gold
 * pick), `open` (a picker pill whose popover is showing) and `disabled` (the
 * search chips' third state: a category that matched nothing still renders,
 * because "we looked here and found nothing" is the answer it exists to give,
 * but it doesn't pretend to be togglable).
 *
 * COUNTS STAY AT THE CALL SITE. The two counted rails render them differently
 * on purpose — search shows pending/unknown glyphs in a tabular span, the
 * lenses show a mono tally that goes gold with the chip — and one `count` prop
 * could only serve those by growing a discriminator that buys nothing.
 */
export function Chip({
  state = "idle",
  className,
  children,
  ...rest
}: {
  state?: "idle" | "active" | "open" | "disabled";
  className?: string;
  children?: React.ReactNode;
} & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "children"
>): React.JSX.Element {
  return (
    <button
      className={cx(
        "rounded-full px-3 py-1 text-[12px] ring-1 transition-all",
        state === "disabled"
          ? "ring-edge/60 bg-panel/40 text-faint/50 cursor-default"
          : state === "active"
            ? "ring-gold/50 bg-golddim text-gold"
            : state === "open"
              ? "ring-edge2 bg-raised text-ink"
              : "ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * The gold call-to-action pill — the one loud button on a screen (search this
 * library, play this playlist, install this update).
 *
 * Owns colour, glow, radius and the press/disabled behaviour; the call site
 * brings its own padding, type size and layout, which is why the header CTAs
 * (`px-3.5 h-8`) and the settings-row CTAs (`px-3.5 py-1.5`) can share it.
 *
 * The art blooms on cards and the eqbars badges are NOT this — they are not
 * buttons, and they keep their own bespoke treatments.
 */
export function PrimaryButton({
  className,
  children,
  ...rest
}: {
  className?: string;
  children?: React.ReactNode;
} & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "children"
>): React.JSX.Element {
  return (
    <button
      className={cx(
        "rounded-lg bg-gold text-bg font-medium shadow-[0_0_14px_rgb(var(--gold-rgb)_/_0.3)]",
        "hover:brightness-110 disabled:opacity-40 disabled:shadow-none",
        // a disabled primary is INERT, not merely dim: no hover lift, no press
        // squash (Chromium keeps matching :active on a disabled button, so the
        // Tracks lens's waiting Play these still animated under a click —
        // user, 2026-09-01), and the arrow cursor of a native disabled control
        // rather than the web's scolding not-allowed sign
        "disabled:hover:brightness-100 motion-safe:disabled:active:scale-100 disabled:cursor-default",
        "motion-safe:active:scale-95 transition-all",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
