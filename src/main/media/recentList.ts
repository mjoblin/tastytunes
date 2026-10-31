import { usbServer, type MediaNode, type MediaServerInfo } from "@shared/model";
import {
  isRecentListTitle,
  mayHoldRecentList,
  recentEntriesOf,
  type RecentEntry,
} from "@shared/recentlyAdded";
import { getSettings } from "../data/persist";
import { browseChildrenOf } from "./upnpBrowser";

/**
 * A MEDIA SERVER'S OWN RECENTLY ADDED LIST (0.13.0 round 9; shared/recentlyAdded says what it is
 * for). Found by its name at the server's top level or one level down, under a container named
 * Music, Audio or Media Library (the 2026-08 survey: Asset and Gerbera keep it at the top, Emby,
 * Jellyfin and MiniDLNA under Music, UMS under Media Library's Audio); or the one the reader chose
 * in the Library (a folder's ⋯, Use as Recently added), or none, turned off in Settings ›
 * Libraries. Read at every build of the server's index, a few requests. The streamer's USB drive
 * has none, and its lane is left alone.
 */

export interface RecentListRef {
  id: string;
  title: string;
  /** The folders down to it, by title: an id the server re-mints is found again by them. */
  titlePath: string[];
}

export interface RecentListRead {
  /** The list in use, or null. */
  list: RecentListRef | null;
  /** The reader chose it (else it was found by its name). */
  chosen: boolean;
  /** The reader turned the server's list off. */
  off: boolean;
  /** Its albums, in its order. */
  entries: RecentEntry[];
}

const kidsOf = async (host: string, udn: string, id: string): Promise<MediaNode[] | null> => {
  const got = await browseChildrenOf(host, udn, id, { background: true });
  return typeof got === "string" ? null : got;
};

/** The server's list by its name, at the top or below a Music, Audio or Media Library. */
export async function findRecentList(host: string, udn: string): Promise<RecentListRef | null> {
  const level = async (
    id: string,
    path: string[],
    depth: number,
  ): Promise<RecentListRef | null> => {
    const kids = await kidsOf(host, udn, id);
    if (!kids) return null;
    const hit = kids.find((k) => k.isContainer && isRecentListTitle(k.title));
    if (hit) return { id: hit.id, title: hit.title, titlePath: [...path, hit.title] };
    if (depth >= 2) return null;
    for (const k of kids.filter((c) => c.isContainer && mayHoldRecentList(c.title)).slice(0, 3)) {
      const found = await level(k.id, [...path, k.title], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return level("0", [], 0);
}

/** A folder Settings › Libraries offers as the server's list; `named` marks the one found by its
 *  name (findRecentList's), the list the server uses when the reader has chosen none. */
export interface RecentCandidate extends RecentListRef {
  named: boolean;
}

/** At most this many folders offered (a folder server's top level can be its whole library). */
const CANDIDATES_MAX = 60;

/**
 * The folders the reader may choose the list from, in Settings › Libraries (his ask, 2026-10-25:
 * the control should be there, not only in a folder's ⋯): the server's top-level folders and those
 * under a Music, Audio or Media Library, where the lists live, searched in findRecentList's order.
 * Albums and artists are not folders to choose. None for the streamer's USB drive.
 */
export async function listRecentCandidates(
  host: string,
  server: Pick<MediaServerInfo, "udn" | "isStreamer" | "searchable">,
): Promise<RecentCandidate[]> {
  if (usbServer(server)) return [];
  const out: RecentCandidate[] = [];
  let named = false;
  const level = async (id: string, path: string[], depth: number): Promise<void> => {
    const kids = await kidsOf(host, server.udn, id);
    if (!kids) return;
    for (const k of kids) {
      if (!k.isContainer || /musicAlbum|person/.test(k.upnpClass)) continue;
      const isNamed = !named && isRecentListTitle(k.title);
      if (isNamed) named = true;
      out.push({ id: k.id, title: k.title, titlePath: [...path, k.title], named: isNamed });
    }
    if (depth >= 2) return;
    for (const k of kids.filter((c) => c.isContainer && mayHoldRecentList(c.title)).slice(0, 3))
      await level(k.id, [...path, k.title], depth + 1);
  };
  try {
    await level("0", [], 0);
  } catch {
    // a server not answering offers nothing to choose
  }
  return out.slice(0, CANDIDATES_MAX);
}

/** A chosen list's children: by its id, else found again by its folders' titles. */
async function childrenOfChosen(
  host: string,
  udn: string,
  ref: RecentListRef,
): Promise<MediaNode[] | null> {
  const direct = await kidsOf(host, udn, ref.id);
  if (direct) return direct;
  let id = "0";
  for (const title of ref.titlePath) {
    const kids = await kidsOf(host, udn, id);
    const next = kids?.find((k) => k.isContainer && k.title === title);
    if (!next) return null;
    id = next.id;
  }
  return kidsOf(host, udn, id);
}

/** The server's list as the reader has it: off, chosen, or found by its name. */
export async function readRecentList(
  host: string,
  server: Pick<MediaServerInfo, "udn" | "isStreamer" | "searchable">,
): Promise<RecentListRead> {
  const none = { list: null, chosen: false, off: false, entries: [] };
  if (usbServer(server)) return none;
  const choice = getSettings().recentlyAddedLists[server.udn];
  if (choice === "off") return { ...none, off: true };
  try {
    if (choice) {
      const kids = await childrenOfChosen(host, server.udn, choice);
      return { list: choice, chosen: true, off: false, entries: kids ? recentEntriesOf(kids) : [] };
    }
    const found = await findRecentList(host, server.udn);
    if (!found) return none;
    const kids = await kidsOf(host, server.udn, found.id);
    return { list: found, chosen: false, off: false, entries: kids ? recentEntriesOf(kids) : [] };
  } catch {
    return none;
  }
}
