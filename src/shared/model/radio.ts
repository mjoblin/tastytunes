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
}
