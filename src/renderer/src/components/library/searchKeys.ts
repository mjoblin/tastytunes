/**
 * THE LIBRARY'S SEARCH RESULTS FROM THE KEYBOARD (0.14.0): one list across the
 * windowed lines of results (LibraryScreen's searchLines), where a kind's results are a grid of
 * cards (a line of cards each) or rows, one under another. In a grid all four arrows move, up and
 * down to the card in the same column (or the last of a shorter line); in rows up and down only,
 * left and right staying the track skips; up and down cross from one kind to the next.
 */

/** One result's place in the list. */
export interface SearchSpot {
  /** Its line in the results (searchLines' index). */
  line: number;
  /** Its place in a line of cards; 0 for a row. */
  col: number;
  /** A card in a grid, or a row. */
  card: boolean;
  /** Its kind's section (Artists, Albums, Folders or Tracks, per library). */
  section: number;
}

/** The result an arrow, Home or End goes to from `at`, or null when the key isn't the list's. */
export function searchStep(key: string, at: number, spots: readonly SearchSpot[]): number | null {
  const here = spots[at];
  if (!here) return null;
  // the first result on the line `from` sits on, and how many share it
  const lineOf = (from: number): { first: number; length: number } => {
    let first = from;
    while (first > 0 && spots[first - 1].line === spots[from].line) first--;
    let last = from;
    while (last < spots.length - 1 && spots[last + 1].line === spots[from].line) last++;
    return { first, length: last - first + 1 };
  };
  // into a line: a grid's same column, a row's one result
  const into = (from: number): number => {
    const { first, length } = lineOf(from);
    return spots[first].card ? first + Math.min(here.col, length - 1) : first;
  };
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return spots.length - 1;
    case "ArrowRight":
    case "ArrowLeft": {
      if (!here.card) return null;
      const next = at + (key === "ArrowRight" ? 1 : -1);
      const to = spots[next];
      return to?.card && to.section === here.section ? next : at;
    }
    case "ArrowDown": {
      const { first, length } = lineOf(at);
      const next = first + length;
      return next < spots.length ? into(next) : at;
    }
    case "ArrowUp": {
      const { first } = lineOf(at);
      return first > 0 ? into(first - 1) : at;
    }
    default:
      return null;
  }
}
