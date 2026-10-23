/**
 * THE TRACK A LANDING LOOKS FOR (0.12.0-rc.3, Malcolm's two "Close Your Eyes" on Songbooks+): Open
 * in Library, Go to album and the artist page's links land on an album and wash one row. A row
 * was found by its title alone, so of two tracks with one title on one album (a reprise, the same
 * song on two discs of a box set) the first always won. A landing now carries the track's id and
 * length besides its title, and the row is chosen by id, then by title and a length within two
 * seconds (a server's ids can differ between the paths to one track: MinimServer's search id and
 * its album listing's), then by title alone, the old rule, as the last resort.
 */
export interface LandingTrack {
  title: string;
  id?: string | null;
  secs?: number | null;
}

/** A row as the landing reads it off the listing (data-library-track and its siblings). */
export interface LandingRow {
  title: string;
  id: string | null;
  secs: number | null;
}

/** Within this many seconds two lengths are one track's (servers round differently). */
const SECS_SLACK = 2;

/** The row to land on, by index, or -1 when no row has the title. */
export function landingRowIndex(rows: readonly LandingRow[], want: LandingTrack): number {
  if (want.id) {
    const byId = rows.findIndex((r) => r.id === want.id);
    if (byId >= 0) return byId;
  }
  const titled = rows.flatMap((r, i) => (r.title === want.title ? [i] : []));
  if (titled.length === 0) return -1;
  if (want.secs != null) {
    const close = titled.filter((i) => {
      const s = rows[i].secs;
      return s != null && Math.abs(s - (want.secs as number)) <= SECS_SLACK;
    });
    if (close.length > 0) {
      // the nearest length, when two twins both fall within the slack
      return close.reduce((best, i) =>
        Math.abs((rows[i].secs as number) - (want.secs as number)) <
        Math.abs((rows[best].secs as number) - (want.secs as number))
          ? i
          : best,
      );
    }
  }
  return titled[0];
}
