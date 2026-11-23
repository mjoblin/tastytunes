import type { ExportOptions } from "./exporter";

/**
 * THE README IN EVERY EXPORT (0.17.0, export for an agent): what each file and field is, the
 * units, where each part came from and the rights note, so the folder explains itself to whoever
 * opens it, a person or another agent, with TastyTunes nowhere near.
 */
export function exportReadme(kind: "track" | "album", opts: ExportOptions): string {
  const layout =
    kind === "track"
      ? `- \`track.json\`: everything about the track, described below.
- \`analysis.json\`: the full audio analysis, frame by frame (only when the track has been analyzed).
- \`lyrics.lrc\` and \`lyrics.txt\`: the lyrics, timed and plain, when there are any.
- \`audio.*\`: the track's file itself, only when the export was asked to copy it.
- \`pictures/\`: the pictures, and \`pictures/pictures.json\`, which says what each one is.`
      : `- \`album.json\`: the album, its notes, what was measured across it, and its tracks in order.
- \`tracks/NN - Title/\`: one folder per track, each with its own \`track.json\`, \`analysis.json\`,
  lyrics and audio, as a single-track export has them.
- \`pictures/\`: the pictures, once for the whole album, and \`pictures/pictures.json\`.`;

  return `# A TastyTunes export

This folder holds what TastyTunes knew about this ${kind} when it was exported: who made it, the
file, the audio analysis, the lyrics, the credits and notes, how often it was played, and the
pictures. It is format \`tastytunes.export/1\`. Every file is plain JSON or text, with the unit in
each field's name or beside it.

## Files

${layout}

## track.json

- \`identity\`: title, artists, album, album artist, composers, year, genres, track and disc
  numbers, and the duration in seconds, as the library's tags give them.
- \`file\`: the format (codec, bit depth, sample rate in Hz, bitrate in kbps, size in bytes,
  channels) and the media server that holds it. \`other_copies\` lists the same song elsewhere in
  the library.
- \`measured\`: the headline measurements. \`dr\` is dynamic range as the DR database measures it.
  \`lufs\` is EBU R128 integrated loudness, \`loudness_range_lu\` its range, \`true_peak_dbtp\` the
  true peak. \`tempo_bpm\` and \`key\` are given only when the analysis is confident of them.
- \`lyrics\`: \`lines\` are the timed lines (\`at_seconds\`, \`text\`), \`plain\` the words as one
  text, \`instrumental\` whether the track is marked as having none. From LRCLIB (lrclib.net).
- \`credits\`: who performed, produced and wrote the recording, each a role and a name. From
  MusicBrainz.
- \`album_notes\` and \`artist_notes\`: the album's label, type, genres, credits and summary, and
  the artist's summary, with their Wikipedia and MusicBrainz addresses.
- \`listening\`: how many times it was played in TastyTunes, how many of those were heard
  through, the minutes played, and when it was first and last played.${
    opts.plays && !opts.redact ? " `every_play` lists each play with its date." : ""
  }
- \`held_by\`: whether the track or its album is a favorite, and the playlists that hold it.
  \`presets_holding_album\` names the streamer's presets that recall its album.
- \`timeline\`: built to cut against. \`sections\` are the parts of the track, each with its start
  and end in seconds, its energy (0 to 1), its mean loudness in dBFS and brightness (0 dark to 1
  bright), and the lyric lines that fall in it. A section's \`kind\` is \`repeated_loud\` for the
  kind of part that comes back most and is loudest, often what you'd call the chorus, or \`other\`.
  The analysis can't tell a verse from a chorus, so it doesn't name them. \`moments\` are the
  points worth cutting on, in time order: where each build starts and its drop lands, where each
  silence starts and ends, the loudest and the quietest second, and the first and last lyric line.
- \`audio\`: \`link\` gives the track's address on the owner's media server, which plays only from
  their network while the server is up. \`copy\` names the file in this folder. \`none\` means it
  was left out.
- \`missing\`: what this export doesn't have, why, and what would fill it.

## analysis.json

Measured from the audio file itself, in TastyTunes. \`analysis_version\` names the version of the
analysis that measured it.

- \`tempo\`: beats per minute, the confidence (0 to 1), which beat is the downbeat (0 to 3), and
  every beat's time in seconds.
- \`key\`: the key and the confidence. \`chord_changes_seconds\`: where the harmony changes.
- \`sections\`: the boundaries between sections in seconds, each section's kind and energy.
- \`silences\`: each silence's start and end. \`drops\`: where each build starts and where it
  lands, its strength (0 to 1), and how long the music eased off, went near silent and cut out
  just before it.
- \`onsets\`: every drum hit found, its time, its strength (0 to 1, against the track's strongest)
  and its kind (kick, snare or hat).
- \`curves\`: values sampled \`fps\` times a second. \`loudness_dbfs\`; \`bands_dbfs\`, six frequency
  bands per frame between the edges in \`edges_hz\`; \`brightness\` and \`noisiness\` (0 to 1);
  \`pan\` (-1 left to 1 right) and \`width\` (0 mono to 1 wide); \`chroma\`, the strength of each
  of the twelve pitch classes per frame (0 to 1).
- \`waveform\`: the peak and RMS level (0 to 1) at evenly spaced points across the track.

## pictures

\`pictures.json\` lists each picture: what it is (\`sleeve\`, \`artist\`, or \`shelf\` for the
artist's other albums in the library), where it came from, and its \`file\` here when it was
copied. A picture with no file is listed with its address only.

## Rights

The pictures, lyrics, notes and audio belong to their owners. This export is for the owner's own
use, as the music in their library is.${
    opts.redact
      ? "\n\nThis export is redacted: it leaves out addresses on the owner's network, server and device ids, and the dates of plays."
      : ""
  }
`;
}
