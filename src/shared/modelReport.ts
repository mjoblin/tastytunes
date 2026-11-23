import { REPO_URL } from "./ipc";

/**
 * MODEL CHECK-IN (0.17.0): one click on the Device screen opens a prefilled GitHub issue saying how
 * TastyTunes works with the streamer in hand. The app sends nothing: the browser opens the issue
 * form, and nothing leaves until the owner submits it there. The report carries the model, its
 * firmware and API version, the app's version and platform, and the wire check's notes (field
 * names and kinds, never values). Never the streamer's UDN, unit id (its serial), its name, an
 * address, or anything about the listener.
 */
export interface ModelFacts {
  model: string | null;
  api: string | null;
  versions: ReadonlyArray<{ component: string | null; version: string | null }> | null;
  appVersion: string;
  platform: string;
  /** The wire check's notes, as the log has them ("/zone/play_state: … set aside"). */
  wire: readonly string[];
}

/** How many wire notes a report lists (a long list says no more, and the address stays short). */
export const MAX_WIRE_NOTES = 20;

export function modelReport(f: ModelFacts): { title: string; body: string } {
  const model = f.model?.trim() || "an unnamed model";
  const firmware =
    (f.versions ?? [])
      .filter((v) => v.version)
      .map((v) => (v.component ? `${v.component} ${v.version}` : v.version))
      .join(", ") || "not reported";
  const wire = f.wire.slice(0, MAX_WIRE_NOTES);
  const more = f.wire.length - wire.length;
  const lines = [
    "### Model check-in",
    "",
    `- Model: ${model}`,
    `- Firmware: ${firmware}`,
    `- API version: ${f.api ?? "not reported"}`,
    `- TastyTunes: ${f.appVersion} on ${f.platform}`,
    "",
    "Messages from the streamer that TastyTunes couldn't fully read:",
    "",
    ...(wire.length ? wire.map((w) => `- ${w}`) : ["- None."]),
    ...(more > 0 ? [`- …and ${more} more.`] : []),
    "",
    "### What works, and what doesn't",
    "",
    "",
  ];
  return { title: `Model check-in: ${model}`, body: lines.join("\n") };
}

/** The GitHub address that opens the issue form with the report filled in. */
export function modelReportUrl(f: ModelFacts): string {
  const { title, body } = modelReport(f);
  const q = new URLSearchParams({ title, body });
  return `${REPO_URL}/issues/new?${q.toString()}`;
}
