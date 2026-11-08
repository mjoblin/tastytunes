// THE CONNECTIONS TAB (moved out of SettingsScreen.tsx as it was, 0.16.0's tidy before the design pass:
// each tab its own section, as Libraries, History, Updates, Schedules and AI agents already were).
import { FanartKeyRow } from "@/components/settings/FanartKeyRow";
import { ListenBrainzSection } from "@/components/settings/ListenBrainzSection";
import {
  CacheRow,
  SettingsCard,
  Toggle,
  type SectionProps,
} from "@/components/settings/SettingsKit";

export function ConnectionsSection({ settings, save }: SectionProps): React.JSX.Element {
  return (
    <section className="space-y-3">
      {/* everything here talks to a service outside the LAN — each row says
              exactly what leaves the machine, and off always means zero requests */}
      <SettingsCard>
        <Toggle
          label="Lyrics on Now Playing"
          hint="Adds a lyrics panel to the Now Playing screen, fetched (when open) from lrclib.net. Sends the current track's title and artist to LRCLIB; off means no requests will be sent."
          checked={settings.lyrics}
          onChange={(lyrics) => void save({ lyrics })}
        />

        <Toggle
          label="Current lyric line"
          hint="Shows the live synced lyric under the track details on Now Playing (hidden while the full panel is open). Looks up each track as it plays, the same LRCLIB request as above."
          disabled={!settings.lyrics}
          checked={settings.lyricsLine}
          onChange={(lyricsLine) => void save({ lyricsLine })}
        />

        <Toggle
          label="Liner notes"
          hint="The panel on Now Playing with Artist, Album and Track tabs: Wikipedia summaries, release details and track credits matched via MusicBrainz, fetched when you open them. Also shows a CD's track names on the Queue screen and artists' photos in the Library. Sends the current artist, album and track names, an artist's name when you open their page, the names of the artists in your library to have their photos ready, an artist's name when you look for a picture of them on Wikimedia Commons, or a CD's MusicBrainz release. Off means no requests will be sent. The panel's Stream tab stays either way."
          checked={settings.artistInfo}
          onChange={(artistInfo) => void save({ artistInfo })}
        />

        <FanartKeyRow lookups={settings.artistInfo} />

        <Toggle
          label="Missing album art"
          hint="Fills in art the media server doesn't have: MusicBrainz identifies the album, the Cover Art Archive supplies the image. Server art always wins."
          checked={settings.albumArtLookup}
          onChange={(albumArtLookup) => void save({ albumArtLookup })}
        />

        <Toggle
          label="Internet radio directory"
          hint="Finds stations through radio-browser.info: the Radio screen's search and top lists, and the radio results in unified search. Sends what you type. Off means no requests will be sent. Favorited stations still play either way: a favorite keeps its own stream URL."
          checked={settings.radioDirectory}
          onChange={(radioDirectory) => void save({ radioDirectory })}
        />

        <ListenBrainzSection settings={settings} save={save} />

        <CacheRow />
      </SettingsCard>
    </section>
  );
}
