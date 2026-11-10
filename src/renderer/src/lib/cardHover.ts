// A CARD'S HOVER (0.15.0, the hygiene pass: written out by hand in six places, its motion in two
// homes that had to agree, lib/dnd's style and the Library's classes). Under the pointer a card
// lifts above its neighbors and grows a little where motion is welcome, over 200 ms easing out;
// while its menu is open it holds that look. A card dnd-kit moves takes the motion as a style
// (CARD_MOTION, for sortableStyle), since dnd-kit writes the transition itself; every other card
// takes it as classes (CARD_TRANSITION). The lint rule card-hover refuses the scale spelled out
// anywhere else.

/** The hover: above the neighbors, a little larger (scale is layout-free, so a card at the
 *  scrollport's edge simply clips there). */
export const CARD_HOVER = "hover:z-10 motion-safe:hover:scale-[1.04]";

/** The hover's look, held while the card's menu or popover is open. */
export const CARD_HELD = "z-10 motion-safe:scale-[1.04]";

/** The card's motion as classes: its grow, fill and glow. */
export const CARD_TRANSITION = "transition-all duration-200 ease-out";

/** The same motion as a transition style, for a card dnd-kit moves. */
export const CARD_MOTION = "all 200ms cubic-bezier(0, 0, 0.2, 1)";
