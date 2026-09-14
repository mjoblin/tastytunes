// What the demo streamer and its library share (split out 2026-09-13 with the
// library): the queue's size and playing id, the XML escape, the duration
// format, the DIDL container and the loose dictionary type.

export const QUEUE_LEN = 30;

export const PLAYING_QUEUE_ID = 28;

export type Dict = Record<string, unknown>;

export const xmlEsc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const durFmt = (secs: number): string =>
  `0:${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}.000`;

export const didlContainer = (
  id: string,
  parent: string,
  title: string,
  cls: string,
  art: string | null,
  artist?: string,
  date?: string,
  genres?: string[],
): string =>
  `<container id="${id}" parentID="${parent}" restricted="true"><upnp:class>${cls}</upnp:class><dc:title>${xmlEsc(title)}</dc:title>${art ? `<upnp:albumArtURI>${art}</upnp:albumArtURI>` : ""}${artist ? `<upnp:artist>${xmlEsc(artist)}</upnp:artist>` : ""}${date ? `<dc:date>${date}</dc:date>` : ""}${(genres ?? []).map((g) => `<upnp:genre>${xmlEsc(g)}</upnp:genre>`).join("")}</container>`;
