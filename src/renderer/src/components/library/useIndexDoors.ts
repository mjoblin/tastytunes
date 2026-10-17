import { useMemo } from "react";
import { useStore } from "@/store";
import type { MediaIndexStatus } from "@shared/model";

export type DoorsState = "ready" | "building" | "failed" | "hidden";

/** What the media indexes offer the Library right now: the lens doors' state, and whether
 *  cross-server search is there or on its way (split out of LibraryScreen in the 0.11.0
 *  sweep; the root view and the screen's header both read it). */
export function useIndexDoors(): {
  mediaIndexStatuses: MediaIndexStatus[];
  readyIndexes: MediaIndexStatus[];
  buildingCount: number;
  failedIndexes: MediaIndexStatus[];
  crossAvailable: boolean;
  crossPending: boolean;
  doorsState: DoorsState;
} {
  // Cross-server search: every READY index at once, grouped by server. It
  // activates at TWO ready indexes — with one, the scoped per-server flow
  // already covers everything (and keeps its live fallback).
  const mediaIndexStatuses = useStore((s) => s.mediaIndex);
  const readyIndexes = useMemo(
    () => mediaIndexStatuses.filter((x) => x.state === "ready"),
    [mediaIndexStatuses],
  );
  const crossAvailable = readyIndexes.length >= 2;
  // The button used to POP IN when the second index finished building —
  // confusing (real-user report). While builds that will unlock cross
  // search are still running, show it disabled with a building tip instead.
  // aria-disabled (not the HTML attr) keeps the hover tip alive — the
  // cross-search server filter's precedent.
  const buildingCount = useMemo(
    () => mediaIndexStatuses.filter((x) => x.state === "building").length,
    [mediaIndexStatuses],
  );
  const crossPending =
    !crossAvailable && buildingCount > 0 && readyIndexes.length + buildingCount >= 2;

  // The lenses: OUR views over the union of ready indexes, offered as doors
  // at the root beside the sources (places, not modes). One ready index is
  // enough — for a Browse-only USB stick the lens is the first real library
  // UI it's ever had.
  const lensAvailable = readyIndexes.length >= 1;
  // The doors used to POP IN when the first index finished building — the
  // same complaint the cross-search button drew (see above), and every
  // schema bump replays it for everyone. So the block is on screen from the
  // moment anything is BUILDING (or has FAILED — a silent "not indexed" told
  // nobody anything): building doors are dimmed with a pulsing icon and say
  // so, failed ones offer Retry in place, and because the block holds its
  // space from the first paint nothing below it ever moves. Hidden only when
  // no index exists AND nothing is building or failed (a fresh browse-only
  // setup: the servers' own tiles are right below).
  const failedIndexes = useMemo(
    () => mediaIndexStatuses.filter((x) => x.state === "failed"),
    [mediaIndexStatuses],
  );
  const doorsState: DoorsState = lensAvailable
    ? "ready"
    : buildingCount > 0
      ? "building"
      : failedIndexes.length > 0
        ? "failed"
        : "hidden";
  return {
    mediaIndexStatuses,
    readyIndexes,
    buildingCount,
    failedIndexes,
    crossAvailable,
    crossPending,
    doorsState,
  };
}
