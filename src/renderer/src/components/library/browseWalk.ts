/**
 * THE SERVER'S OWN FOLDER PATH FOR A BROWSE (0.13.0-rc.4; two copies of one album on a drive,
 * opened from the Albums lens: "Couldn't browse this library", Retry no help, while the drive's
 * folders found them). A server that refuses an id (the streamer re-mints its drive's ids on a wake or a
 * changed drive) has the browse re-walk these titles from its top (upnpBrowser browse). The
 * deepest crumb that carries a walked path (an index node's titlePath: an album opened from a
 * lens, the artist page or a search) gives it, with any folder entered below it; without one,
 * the trail's own titles, less the app's crumbs (a lens, an artist, a search), are the server's
 * folders. The trail alone, from a lens, is "Albums › the album", which no server has.
 */
export function browseWalk(
  path: ReadonlyArray<{ id: string; title: string; node?: { titlePath?: string[] } | null }>,
  isAppCrumb: (id: string) => boolean,
): string[] {
  const titles = (crumbs: typeof path): string[] =>
    crumbs.filter((c) => !isAppCrumb(c.id)).map((c) => c.title);
  for (let i = path.length - 1; i >= 0; i--) {
    const walked = path[i].node?.titlePath;
    if (walked && walked.length > 0) return [...walked, ...titles(path.slice(i + 1))];
  }
  return titles(path);
}
