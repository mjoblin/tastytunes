import type { LibrarySpot } from "@/store";

/**
 * The Library's CURRENT spot, registered while the screen is mounted, so the
 * store can record it as the thing being left when a navigation goes
 * elsewhere (history needs the spot at the moment of leaving; component state
 * is not reachable from the store). A tiny module so the store and the screen
 * share it without importing each other.
 */
let spot: LibrarySpot | null = null;
export const currentLibrarySpot = (): LibrarySpot | null => spot;
export const setCurrentLibrarySpot = (s: LibrarySpot | null): void => {
  spot = s;
};
