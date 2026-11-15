// Internet radio stations.

// ------------------------------------------------------------------ internet radio

/** A station from the radio-browser.info community directory (main-process lookup). */
export interface RadioStation {
  uuid: string;
  name: string;
  /** The playable stream URL (radio-browser's url_resolved — playlists unwrapped). */
  url: string;
  favicon: string | null;
  homepage: string | null;
  /** Comma-separated tag list as the directory provides it. */
  tags: string;
  country: string;
  codec: string;
  /** kbps; 0 = unknown. */
  bitrate: number;
  /** ISO 3166-1 alpha-2, as the directory gives it (0.16.0, for an agent's answer). */
  countryCode?: string;
  /** The directory's language names, comma-separated. */
  language?: string;
  /** Listeners' votes for the station in the directory. */
  votes?: number;
}
