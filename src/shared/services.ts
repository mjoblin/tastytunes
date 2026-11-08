// THE SERVICES THE APP TALKS TO (0.15.0: the site's and the README's "complete list" of what
// leaves the machine had drifted from the code, missing fanart.tv,
// Wikimedia Commons and the background artist lookups). One home: every request the main process
// logs names one of these (loggedFetch takes a ServiceId), so a new service cannot be called
// without a line here, and services.test.ts holds the README's "What leaves your machine" to the
// internet ones' hosts.

export interface Service {
  /** Where the requests go: devices on the local network, the internet, or either (art is kept
   *  wherever its source keeps it). */
  where: "lan" | "internet" | "either";
  /** The hosts an internet service is reached at, as the README names them. */
  hosts?: readonly string[];
  /** What it is sent, in the reader's words. */
  sent: string;
}

export const SERVICES = {
  upnp: { where: "lan", sent: "browsing, searching and queueing on your local media servers" },
  ssdp: { where: "lan", sent: "finding your streamer and local media servers" },
  "media-art": { where: "lan", sent: "a track's file, for the art inside it" },
  "media-audio": { where: "lan", sent: "a track's file, to analyze its audio" },
  demo: { where: "lan", sent: "the built-in demo streamer, on your own computer" },
  art: {
    where: "either",
    sent: "album art, station logos and artist pictures, from where each is kept",
  },
  lrclib: {
    where: "internet",
    hosts: ["lrclib.net"],
    sent: "the playing track's title, artist, album and duration",
  },
  musicbrainz: {
    where: "internet",
    hosts: ["musicbrainz.org"],
    sent: "artist and album names, and a CD's release",
  },
  wikidata: {
    where: "internet",
    hosts: ["wikidata.org"],
    sent: "an artist's or album's MusicBrainz link",
  },
  wikipedia: { where: "internet", hosts: ["wikipedia.org"], sent: "an article's title" },
  commons: {
    where: "internet",
    hosts: ["commons.wikimedia.org"],
    sent: "an artist's name, when you look for a picture of them",
  },
  fanart: {
    where: "internet",
    hosts: ["fanart.tv"],
    sent: "an artist's MusicBrainz identifier, with your key",
  },
  caa: {
    where: "internet",
    hosts: ["coverartarchive.org"],
    sent: "an album's MusicBrainz identifier",
  },
  "radio-browser": {
    where: "internet",
    hosts: ["radio-browser.info"],
    sent: "your station searches",
  },
  listenbrainz: {
    where: "internet",
    hosts: ["listenbrainz.org"],
    sent: "your listens, with your token",
  },
  github: { where: "internet", hosts: ["github.com"], sent: "a request for the latest release" },
} as const satisfies Record<string, Service>;

export type ServiceId = keyof typeof SERVICES;
