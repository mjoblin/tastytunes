import { app, BrowserWindow, dialog } from "electron";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { IPC } from "@shared/ipc";
import { playAlbumKey, playKey, type MediaIndexPools } from "@shared/model";
import { broadcastListening } from "../app/broadcast";
import { getMainWindow } from "../app/windows";
import { listeningRecord } from "../data/listeningRecord";
import { playStatsFromRecord } from "../data/playStats";
import { capturesByAlbum, recentArtGet } from "../lookups/recentArt";
import * as mediaIndex from "../media/mediaIndex";
import { handle } from "../app/guard";

/**
 * THE LIBRARY'S ART BY CONTENT KEY (0.11.0 sweep): playKey → the first track's picture,
 * made once per pools answer (which is itself made once per set of stored indexes) instead
 * of a walk over every track of every library for each slice of the Timeline.
 */
interface LibraryArt {
  byTrack: Map<string, string | null>;
  /** One picture per album (playAlbumKey): a track the library does not hold under that
   *  title still shows its album's cover. */
  byAlbum: Map<string, string>;
}
const artByKey = new WeakMap<MediaIndexPools[], LibraryArt>();
function libraryArt(groups: MediaIndexPools[]): LibraryArt {
  let art = artByKey.get(groups);
  if (art) return art;
  art = { byTrack: new Map(), byAlbum: new Map() };
  for (const g of groups)
    for (const t of g.tracks) {
      const k = playKey(t.title, t.artist, t.album);
      if (art.byTrack.get(k) == null) art.byTrack.set(k, t.artUrl ?? null);
      const album = playAlbumKey(k);
      if (album && t.artUrl && !art.byAlbum.has(album)) art.byAlbum.set(album, t.artUrl);
    }
  artByKey.set(groups, art);
  return art;
}

/** The listening record and play stats: the History screen's reads, export, clear and the stats card. (Split out of index.ts's registerIpc in the 0.11.0 sweep.) */
export function registerListeningIpc(): void {
  handle(IPC.listeningStats, () => listeningRecord.stats());
  handle(IPC.playStats, () => playStatsFromRecord());
  // the Timeline's art: the record stores none, the index knows the track
  handle(IPC.libraryArtByKeys, (_e, keys: unknown) => {
    const want = new Set(
      Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [],
    );
    const out: Record<string, string | null> = {};
    if (want.size === 0) return out;
    const art = libraryArt(mediaIndex.pools());
    for (const k of want) out[k] = art.byTrack.get(k) ?? null;
    // not in the library: the device log's captured picture, if any
    for (const k of want) if (out[k] == null) out[k] = recentArtGet(k) ?? out[k] ?? null;
    // a track's cover is its album's (2026-10-11): the library's picture for the album, else a
    // cover the device log captured for another of its tracks
    let captured: Map<string, string> | null = null;
    for (const k of want) {
      const album = out[k] == null ? playAlbumKey(k) : null;
      if (album == null) continue;
      out[k] = art.byAlbum.get(album) ?? (captured ??= capturesByAlbum()).get(album) ?? null;
    }
    return out;
  });
  handle(IPC.listeningYears, () => listeningRecord.years());
  handle(IPC.listeningStreamers, () => listeningRecord.streamers());
  handle(IPC.listeningYear, (_e, year: unknown) =>
    typeof year === "number" ? listeningRecord.readYear(year) : { events: [], unreadable: 0 },
  );
  handle(IPC.listeningClear, async () => {
    await listeningRecord.clear();
    // the reading surfaces re-seed from the (now empty) record
    void playStatsFromRecord().then((data) => {
      for (const w of BrowserWindow.getAllWindows())
        w.webContents.send(IPC.push, { kind: "playStats", data });
    });
    broadcastListening();
    return listeningRecord.stats();
  });
  handle(IPC.listeningExport, async () => {
    const opts = {
      title: "Export listening history",
      defaultPath: join(app.getPath("downloads"), "tastytunes-history.jsonl"),
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
    };
    const win = BrowserWindow.getFocusedWindow() ?? getMainWindow();
    const picked = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (picked.canceled || !picked.filePath) return null;
    const events = await listeningRecord.exportToFile(picked.filePath);
    return { file: basename(picked.filePath), events };
  });
  // THE STATS CARD (0.9.0): the renderer draws it, main writes the PNG where the user says —
  // the Downloads folder by default, no dialog under the harness (TASTYTUNES_TEST_SAVE_DIR)
  handle(IPC.statsCardSave, async (_e, png: unknown, name: unknown) => {
    if (!(png instanceof Uint8Array) || typeof name !== "string") throw new Error("bad card");
    const safeName = basename(name).replace(/[^\w.-]/g, "_") || "tastytunes-listening.png";
    const testDir = process.env.TASTYTUNES_TEST_SAVE_DIR;
    let filePath: string;
    if (testDir) filePath = join(testDir, safeName);
    else {
      const opts = {
        title: "Save the picture",
        defaultPath: join(app.getPath("downloads"), safeName),
        filters: [{ name: "PNG image", extensions: ["png"] }],
      };
      const win = BrowserWindow.getFocusedWindow() ?? getMainWindow();
      const picked = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts);
      if (picked.canceled || !picked.filePath) return null;
      filePath = picked.filePath;
    }
    await writeFile(filePath, Buffer.from(png));
    return { file: basename(filePath) };
  });
}
