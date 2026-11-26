import { LISTEN_DEFINITION, LISTEN_FLOOR_SECS } from "@shared/model";
import type { ExportOptions } from "./exporter";
import { EXPORT_FORMAT } from "./trackRecord";

/** The fields about the export itself, in the record that holds them (a track's own export's
 *  track.json, or album.json). */
const ABOUT_THE_EXPORT = `- \`pictures\`: where the pictures are listed, \`pictures/pictures.json\`.
- \`exported_at\`: when the export was made, in local time with its offset from UTC.
- \`redacted\`: whether this export leaves out addresses on the owner's network, server ids and
  the dates of plays.`;

/** album.json's own fields, in an album's export. */
const ALBUM_JSON = `## album.json

- \`identity\`: title, artist, year, genres, the number of tracks and discs, the length in
  seconds, and the media server and the album's id on it.
- \`measured\`: how many tracks were analyzed, and the album's DR and loudness in LUFS, given only
  when every track is.
- \`notes\`: the album's title, year, type, label, genres, credits and summary, with its Wikipedia
  and MusicBrainz addresses.
- \`held_by\`: \`hearted\`, whether the album is a favorite.
- \`tracks\`: the tracks in running order, each with its disc and number, title, artist, length in
  seconds, its folder under \`tracks/\`, whether it was analyzed and whether its lyrics are timed.
- \`artist_notes\`: the artist's summary, with its Wikipedia and MusicBrainz addresses (\`null\` for
  a compilation, which has no one artist).
- \`presets_holding_album\`: the streamer's presets that recall the album, each its \`slot\` and
  \`name\`.
${ABOUT_THE_EXPORT}
- \`missing\`: as in each track.json, a gap every track shares said once, with how many tracks it
  touches.
- \`left_out\`: every file of the export that couldn't be written, and any track that couldn't be
  exported, each with why. It is empty when everything was written.

`;

/**
 * THE README IN EVERY EXPORT (0.17.0, export for an agent): what each file and field is, the
 * units, where each part came from and the rights note, so the folder explains itself to whoever
 * opens it, a person or another agent, with TastyTunes nowhere near.
 */
export function exportReadme(kind: "track" | "album", opts: ExportOptions): string {
  const layout =
    kind === "track"
      ? `- \`track.json\`: everything about the track, described below.
- \`analysis.json\`: the full audio analysis, frame by frame (only when the track has been
  analyzed, and only the waveform when that is all its file allowed).
- \`lyrics.lrc\` and \`lyrics.txt\`: the lyrics, timed and plain, when there are any.
- \`audio.*\`: the track's file itself, only when the export was asked to copy it.
- \`pictures/\`: the pictures, and \`pictures/pictures.json\`, which says what each one is.`
      : `- \`album.json\`: the album, its notes, what was measured across it, and its tracks in order.
- \`tracks/NN - Title/\`: one folder per track, each with its own \`track.json\`, \`analysis.json\`,
  lyrics and audio. What the whole album shares is in \`album.json\` once, so a track's
  \`track.json\` here has no \`album_notes\`, \`artist_notes\`, \`presets_holding_album\`,
  \`pictures\`, \`exported_at\`, or \`redacted\`, and adds \`position\`, the track's number on its
  disc (as \`identity.track_number\`).
- \`pictures/\`: the pictures, once for the whole album, and \`pictures/pictures.json\`.`;
  const last =
    kind === "track"
      ? "`track.json` is written last, so a folder without it did not finish."
      : "`album.json` is written last, and each track's `track.json` last in its folder, so a\nfolder without its record did not finish.";

  return `# A TastyTunes export

This folder holds what TastyTunes knew about this ${kind} when it was exported: who made it, the
file, the audio analysis, the lyrics, the credits and notes, how often it was played, and the
pictures. It is format \`${EXPORT_FORMAT}\`, which each JSON file names in its \`format\`. Every
file is plain JSON or text, with the unit in each field's name or beside it.

## Files

${layout}

${last}

${kind === "album" ? ALBUM_JSON : ""}## track.json

- \`identity\`: title, artists, album, album artist, composers, year, genres, track and disc
  numbers, and the duration in seconds, as the library's tags give them.
- \`file\`: the format (codec, bit depth, sample rate in Hz, bitrate in kbps, size in bytes,
  channels) and the media server that holds it. \`other_copies\` lists the same song elsewhere in
  the library.
- \`measured\`: the headline measurements, \`null\` when the track hasn't been analyzed. \`dr\` is
  dynamic range as the DR database measures it. \`lufs\` is EBU R128 integrated loudness,
  \`loudness_range_lu\` its range, \`true_peak_dbtp\` the true peak, \`peak_db\` the highest sample
  and \`rms_db\` the RMS level across the track, both in dBFS. \`tempo_bpm\` and \`key\` are given
  only when the analysis is confident of them; \`tempo_confidence\` and \`key_confidence\` (0 to 1)
  say how confident it is either way. \`details\` names \`analysis.json\` when the folder has one.
- \`lyrics\`: \`lines\` are the timed lines (\`at_seconds\`, \`text\`), \`plain\` the words as one
  text, \`instrumental\` whether the track is marked as having none, and \`synced\` whether there
  are timed lines. \`source\` names where they came from, LRCLIB (lrclib.net).
- \`credits\`: who performed, produced and wrote the recording, each a role and a name. From
  MusicBrainz.${
    kind === "track"
      ? `
- \`album_notes\` and \`artist_notes\`: the album's label, type, genres, credits and summary, and
  the artist's summary, with their Wikipedia and MusicBrainz addresses.`
      : ""
  }
- \`listening\`: how many times it was played in TastyTunes (\`plays\`), how many of those were
  listens (\`full_listens\`)${
    opts.redact
      ? " and the minutes played (`minutes_played`)."
      : `, the minutes played (\`minutes_played\`), and when it was first and
  last played (\`first_played\` and \`last_played\`).`
  }
  ${LISTEN_DEFINITION}
  A play of a track under ${LISTEN_FLOOR_SECS} seconds never counts. It is \`null\` when the owner
  keeps no listening record.${
    opts.plays && !opts.redact
      ? ` \`every_play\` lists each play: when (\`at\`), the seconds played
  (\`seconds_played\`), and whether it was a listen (\`full_listen\`).`
      : ""
  }
- \`held_by\`: whether the track or its album is a favorite, and the playlists that hold it.${
    kind === "track"
      ? `
  \`presets_holding_album\` names the streamer's presets that recall its album.`
      : ""
  }
- \`timeline\`: built to cut against. \`sections\` are the parts of the track, each with its start
  and end in seconds, its energy (0 to 1), its mean loudness in dBFS and brightness (0 dark to 1
  bright), and the lyric lines that fall in it. A section's \`kind\` is \`repeated_loud\` for the
  kind of part that comes back most and is loudest, often what you'd call the chorus, or \`other\`.
  The analysis can't tell a verse from a chorus, so it doesn't name them. \`moments\` are the
  points worth cutting on, in time order, each with its time (\`at_seconds\`) and what it is
  (\`what\`): \`build_starts\` where a build starts and \`drop\` where it lands (with its
  \`strength\`, 0 to 1), \`silence_starts\` and \`silence_ends\`, \`loudest_second\` and
  \`quietest_second\`, and \`first_lyric\` and \`last_lyric\`.
- \`audio\`: \`mode\` is \`link\`, \`copy\`, or \`none\`, as the export was asked. With \`link\`,
  \`local_address\` is the track's address on the owner's media server, which plays only from
  their network while the server is up. With \`copy\`, \`file\` names the file in this folder.
  \`none\` means it was left out. \`note\`, when there is one, says why the address or the file
  isn't there, or what to know about it.${kind === "track" ? `\n${ABOUT_THE_EXPORT}` : ""}
- \`missing\`: what this export doesn't have, why, and what would fill it.
- \`left_out\`: the files that couldn't be written, each with why. It is empty when every file
  was.

## analysis.json

Measured from the audio file itself, in TastyTunes. \`track\` names the track, and
\`analysis_version\` the version of the analysis that measured it. It holds a value for every
frame of the track, so it is large, and is best read with a script rather than as text. A file
that could be measured for its waveform only has just \`waveform\`, and the rest is \`null\` or
empty.

- \`tempo\`: beats per minute, the confidence (0 to 1), which beat is the downbeat
  (\`downbeat_index\`, 0 to 3, or \`null\` when the analysis can't tell), and every beat's time in
  seconds. Every fourth beat from \`downbeat_index\` is a downbeat, the first beat of a bar.
- \`key\`: the key and the confidence. \`chord_changes_seconds\`: where the harmony changes.
- \`sections\`: the boundaries between sections in seconds (\`bounds_seconds\`, the first section
  starting at 0 and the last running to the end), and each section's kind and energy (\`kinds\`,
  \`energy\`), one value per section in order.
- \`silences\`: each silence's start and end. \`drops\`: where each build starts and where it
  lands, its strength (0 to 1), and how long the music eased off, went near silent and cut out
  just before it.
- \`onsets\`: every drum hit found, as lists in the same order: its time (\`at_seconds\`), its
  strength (\`strength\`, 0 to 1, against the track's strongest) and its kind (\`kind\`, one of
  the kinds in \`kinds\`: kick, snare or hat).
- \`curves\`: values sampled \`fps\` times a second, each curve giving its \`fps\`, its number of
  \`frames\` and its \`values\`. \`loudness_dbfs\`; \`bands_dbfs\`, six frequency bands per frame
  between the edges in \`edges_hz\`; \`brightness\` and \`noisiness\` (0 to 1); \`pan\` (-1 left
  to 1 right) and \`width\` (0 mono to 1 wide); \`chroma\`, the strength of each of the twelve
  pitch classes per frame (0 to 1). Loudness and the bands run from -60 to 0 dBFS, where -60
  stands for -60 or quieter.
- \`waveform\`: the peak and RMS level (0 to 1) at evenly spaced points across the track.

## pictures

\`pictures.json\` lists each picture: what it is (\`sleeve\`; \`release\`, a scan of one pressing
of the album from the Cover Art Archive, its \`types\` saying which, such as Back or Booklet, and
\`release\` naming the pressing on MusicBrainz; \`artist\`; or \`shelf\` for the artist's other
albums in the library), where it came from (\`source\`: \`library\` for the media server's
picture, \`audio file\` for the one inside the track's file, \`Cover Art Archive\`, \`chosen\` for
a photo picked in TastyTunes, \`wikipedia\`, \`commons\`, or \`fanart.tv\`), its address
(\`address\` on the internet, \`local_address\` on the owner's network), a Commons picture's
\`page\`, and its \`file\` here when it was copied. An artist picture's \`width\` and \`height\` are
the original's, in pixels. A Commons file is copied at most 1280 pixels wide, so it can be
smaller than they say. A picture with no file was not copied in. It is listed by its address,
and \`missing\` says why.

## Rights

The pictures, lyrics, notes and audio belong to their owners. This export is for the owner's own
use, as the music in their library is. The album and artist summaries are Wikipedia's text, under
the CC BY-SA license, so reusing one requires crediting its article (its address is in the notes
beside it). Pictures from Wikipedia and Wikimedia Commons each have their own license, shown on
the picture's page (a Commons picture's is \`page\` in \`pictures.json\`).${
    opts.redact
      ? `\n\nThis export is redacted: it leaves out addresses on the owner's network, server and device ids, and the dates of plays, and its JPEG, PNG and WebP pictures carry none of the details a camera or an editor wrote into them (a GIF or an SVG is copied as it came).${
          opts.audio === "copy"
            ? " A copied audio file is the file itself, with its own tags (a bought file can carry its buyer's name)."
            : ""
        }`
      : ""
  }
`;
}
