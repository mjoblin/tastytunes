import { release } from "node:os";
import { join } from "node:path";
import { app, shell } from "electron";
import { LogFile } from "./logFile";

let file: LogFile | null = null;

/** The app's log file under userData (app/logFile), made on first use, after boot has pinned
 *  userData. Each session starts with what support needs first: the version and the system. */
export function appLog(): LogFile {
  return (file ??= new LogFile(
    join(app.getPath("userData"), "logs"),
    () =>
      `TastyTunes ${app.getVersion()} on ${process.platform} ${release()} (${process.arch}), ${new Date().toISOString()}`,
  ));
}

/** Show the log file in Finder or Explorer (the diagnostics drawer's button). */
export function revealLog(): void {
  shell.showItemInFolder(appLog().path);
}
