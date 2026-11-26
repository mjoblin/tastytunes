/**
 * THE FILES A PAGE IS WAITING ON FOR THEIR STORED ANALYSIS (0.17.0, Display on other screens). A
 * page on another screen never measures: the window measures the playing track as it plays, and
 * the app tells every open page when it has stored the analysis of a track a page asked about
 * (display/live's measured, by the analysis key). Each surface showing none for a file names it
 * here while it waits (components/media/waveformAnalysis usePeaks), so that word asks for that file
 * again at once rather than at the next track.
 */

export interface AnalysisWait {
  contentKey: string;
  serverUdn: string;
  objectId: string;
}

const waiting = new Set<AnalysisWait>();

/** One surface waits on a file's stored analysis until the returned function is called. */
export function waitForStored(wait: AnalysisWait): () => void {
  const own = { ...wait };
  waiting.add(own);
  return () => {
    waiting.delete(own);
  };
}

/** The files waiting on `contentKey`, each once however many surfaces show it. */
export function waitingOn(contentKey: string): Array<{ serverUdn: string; objectId: string }> {
  const found = new Map<string, { serverUdn: string; objectId: string }>();
  for (const w of waiting)
    if (w.contentKey === contentKey)
      found.set(`${w.serverUdn}|${w.objectId}`, { serverUdn: w.serverUdn, objectId: w.objectId });
  return [...found.values()];
}
