// SYNCED LYRICS IN LRC FORM, READ ONCE (0.17.0): the window's lyric line and panel and the export
// for an agent read the same lines. Moved from the window's useLyrics, which re-exports it.

export interface SyncedLine {
  t: number;
  text: string;
}

// "[mm:ss.xx] line" — repeated tags on one line share the text.
export function parseLrc(lrc: string): SyncedLine[] {
  const out: SyncedLine[] = [];
  for (const raw of lrc.split("\n")) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (tags.length === 0) continue;
    const text = raw.replace(/\[\d+:\d+(?:\.\d+)?\]/g, "").trim();
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}
