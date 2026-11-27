// THE CONNECTIONS TAB (moved out of SettingsScreen.tsx as it was, 0.16.0's tidy before the design pass:
// each tab its own section, as Libraries, History, Updates, Schedules and AI agents already were).
import { cx } from "@/lib/format";
import { IS_MAC } from "@/lib/screens";
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
          hint="Adds a lyrics panel to the Now Playing screen, fetched (when open) from lrclib.net. Sends the current track's title, artist, album and duration to LRCLIB. Off means no requests will be sent."
          checked={settings.lyrics}
          onChange={(lyrics) => void save({ lyrics })}
        />

        {/* THE CURRENT LYRIC LINE, wherever it's wanted (0.17.0): Now Playing's line as ever, and
            beyond it the playback bar, the mini player and the menu bar panel, each its own switch,
            off by default, so anyone who wants lyrics only on Now Playing sees no change. A place
            switched on keeps its line's room, so nothing moves with the song. */}
        <div className="space-y-3">
          {/* dimmed with its switches while lyrics are off (each switch dims itself) */}
          <div className={cx(!settings.lyrics && "opacity-40")}>
            <div className="text-[13.5px]">Current lyric line</div>
            <div className="text-[11.5px] text-faint max-w-sm">
              The live synced lyric, shown in the places switched on below. Looks up each track as
              it plays, on any screen, the same LRCLIB request as above.
            </div>
          </div>
          <div className="pl-4 ml-1 border-l-2 border-edge/50 space-y-3">
            <Toggle
              label="On Now Playing"
              hint="Under the track details (hidden while the full lyrics panel is open)."
              disabled={!settings.lyrics}
              checked={settings.lyricsLine}
              onChange={(lyricsLine) => void save({ lyricsLine })}
            />
            <Toggle
              label="In the playback bar"
              hint="Under the title and artist at the bottom of the window, on every other screen."
              disabled={!settings.lyrics}
              checked={settings.lyricsLineBar}
              onChange={(lyricsLineBar) => void save({ lyricsLineBar })}
            />
            <Toggle
              label="In the mini player"
              hint="Under the title and artist."
              disabled={!settings.lyrics}
              checked={settings.lyricsLineMini}
              onChange={(lyricsLineMini) => void save({ lyricsLineMini })}
            />
            <Toggle
              label={IS_MAC ? "In the menu bar panel" : "In the tray panel"}
              hint="Under the track, across the panel."
              disabled={!settings.lyrics}
              checked={settings.lyricsLinePanel}
              onChange={(lyricsLinePanel) => void save({ lyricsLinePanel })}
            />
          </div>
        </div>

        <Toggle
          label="Liner notes"
          hint="The panel on Now Playing with Artist, Album and Track tabs: Wikipedia summaries, release details and track credits matched via MusicBrainz, fetched when you open them. Also shows a CD's track names on the Queue screen and artists' photos in the Library. Sends the current artist, album and track names, an artist's name when you open their page, the names of the artists in your library to have their photos ready, an artist's name when you look for a picture of them on Wikimedia Commons, or a CD's MusicBrainz release. Off means no requests will be sent. The panel's Stream tab stays either way."
          checked={settings.artistInfo}
          onChange={(artistInfo) => void save({ artistInfo })}
        />

        <FanartKeyRow lookups={settings.artistInfo} />

        <Toggle
          label="Missing album art"
          hint="Fills in art the media server doesn't have: MusicBrainz identifies the album, the Cover Art Archive supplies the image. Server art always wins. Sends the album's artist and title. For internet radio, it also finds the song's cover, sending the song's artist and title. Off means no requests will be sent."
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
