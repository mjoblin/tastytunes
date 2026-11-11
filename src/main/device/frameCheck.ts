import { z } from "zod";

// THE WIRE'S CHECK (0.16.0 hardening). What the streamer pushes was cast to its type on arrival, so
// a frame from firmware or a model we haven't met could hand a reader null, or a number where it
// reads an object, and throw in main. Each subscribed path's data is checked here, loosely: only the
// kind of each field its type declares (a string, a number, a yes/no, an object, a list), extra
// fields passed through untouched, a missing field left missing. A field of the wrong kind is set
// aside (null, as the types already allow) and named; a list entry of the wrong kind is left out and
// named; a frame whose data isn't an object, or lacks what its readers can't do without (a
// position's number, the power state, a source's id and name), is dropped and named. A frame that
// matches its type passes exactly as it came, so a working streamer sees no change.

export type FrameCheck =
  { ok: true; data: unknown; setAside: string[] } | { ok: false; reason: string };

// the names set aside during one check (checks are synchronous, so one list serves them all)
let setAside: string[] = [];

/** "a string", "a list", "null": what a value was, for the log. */
export const kindOf = (v: unknown): string =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "a list"
      : typeof v === "object"
        ? "an object"
        : typeof v === "boolean"
          ? "a yes/no"
          : `a ${typeof v}`;

/** A field that may be missing or null; of the wrong kind it is set aside as null and named. */
function opt(name: string, kind: z.ZodType): z.ZodType {
  return kind.nullish().catch((ctx: { input: unknown }) => {
    setAside.push(`${name} was ${kindOf(ctx.input)}`);
    return null;
  });
}

/** An object whose every field is optional and checked for its kind (see opt). */
function fields(at: string, kinds: Record<string, z.ZodType>): z.ZodType {
  return z.looseObject(
    Object.fromEntries(Object.entries(kinds).map(([k, kind]) => [k, opt(`${at}${k}`, kind)])),
  );
}

/** A list whose entries not of their kind are left out and named. */
function list(name: string, entry: z.ZodType): z.ZodType {
  return z.array(z.unknown()).transform((entries) =>
    entries.flatMap((it, i) => {
      const r = entry.safeParse(it);
      if (r.success) return [r.data];
      setAside.push(`${name}[${i}] was ${kindOf(it)}, left out`);
      return [];
    }),
  );
}

const str = z.string();
const num = z.number();
const yes = z.boolean();

const PLAY_STATE = fields("", {
  state: str,
  position: num,
  presettable: yes,
  queue_index: num,
  queue_length: num,
  queue_id: num,
  mode_repeat: str,
  mode_shuffle: str,
  metadata: fields("metadata.", {
    class: str,
    source: str,
    name: str,
    playback_source: str,
    track_number: num,
    duration: num,
    album: str,
    artist: str,
    title: str,
    art_url: str,
    sample_format: str,
    mqa: str,
    codec: str,
    lossless: yes,
    sample_rate: num,
    bit_depth: num,
    encoding: str,
    station: str,
    bitrate: num,
    radio_id: num,
  }),
});

const NOW_PLAYING = fields("", {
  state: str,
  source: fields("source.", { id: str, name: str }),
  display: fields("display.", {
    line1: str,
    line2: str,
    line3: str,
    format: str,
    mqa: str,
    playback_source: str,
    class: str,
    art_url: str,
    art_file: str,
    progress: fields("display.progress.", { position: num, duration: num }),
    context: str,
  }),
  queue: fields("queue.", { length: num, position: num, shuffle: str, repeat: str }),
  controls: list("controls", str),
});

const ZONE_STATE = fields("", {
  source: str,
  power: yes,
  pre_amp_mode: yes,
  pre_amp_state: str,
  mute: yes,
  volume_step: num,
  volume_percent: num,
  volume_db: num,
  cbus: str,
});

// tone and EQ are all or nothing: a half-read EQ would show (and write back) bands that aren't there
const ZONE_AUDIO = fields("", {
  volume_limit_percent: num,
  tilt_eq: z.looseObject({ enabled: yes, intensity: num }),
  user_eq: z.looseObject({
    enabled: yes,
    bands: z.array(z.looseObject({ index: num, filter: str, freq: num, gain: num, q: num })),
  }),
  balance: num,
  pipeline: str,
});

const QUEUE_LIST = fields("", {
  start: num,
  count: num,
  total: num,
  play_postition: num, // sic, the streamer's own spelling
  play_id: num,
  items: list(
    "items",
    fields("items[].", {
      id: num,
      position: num,
      metadata: fields("items[].metadata.", {
        class: str,
        source: str,
        name: str,
        title: str,
        art_url: str,
        track_number: num,
        duration: num,
        genre: str,
        album: str,
        artist: str,
      }),
    }),
  ),
});

const PRESETS = fields("", {
  start: num,
  end: num,
  max_presets: num,
  presettable: yes,
  presets: list(
    "presets",
    fields("presets[].", {
      id: num,
      name: str,
      type: str,
      class: str,
      state: str,
      is_playing: yes,
      art_url: str,
      art_urls: list("presets[].art_urls", str),
      airable_radio_id: num,
    }),
  ),
});

const SYSTEM_INFO = fields("", {
  name: str,
  timezone: str,
  locale: str,
  usage_reports: yes,
  setup: yes,
  sources_setup: yes,
  versions: list("versions", fields("versions[].", { component: str, version: str })),
  udn: str,
  hcv: num,
  model: str,
  unit_id: str,
  max_http_body_size: num,
  api: str,
});

const SYSTEM_POWER = z.looseObject({
  power: str,
  standby_mode: opt("standby_mode", str),
  auto_power_down: opt("auto_power_down", num),
});

const SYSTEM_SOURCES = z.looseObject({
  sources: list(
    "sources",
    z.looseObject({
      id: str,
      name: str,
      default_name: opt("sources[].default_name", str),
      class: opt("sources[].class", str),
      nameable: opt("sources[].nameable", yes),
      ui_selectable: opt("sources[].ui_selectable", yes),
      description: opt("sources[].description", str),
      description_locale: opt("sources[].description_locale", str),
      preferred_order: opt("sources[].preferred_order", num),
    }),
  ),
});

/** Each subscribed path's check; a path not here (a command's echo, /queue/info) passes as it came. */
const CHECKS: Record<string, z.ZodType> = {
  "/zone/play_state": PLAY_STATE,
  "/zone/play_state/position": z.looseObject({ position: num }),
  "/zone/now_playing": NOW_PLAYING,
  "/zone/state": ZONE_STATE,
  "/zone/audio": ZONE_AUDIO,
  "/queue/list": QUEUE_LIST,
  "/presets/list": PRESETS,
  "/system/info": SYSTEM_INFO,
  "/system/power": SYSTEM_POWER,
  "/system/display": z.looseObject({ brightness: str }),
  "/system/update": fields("", { early_update: yes, update_available: yes, updating: yes }),
  "/system/sources": SYSTEM_SOURCES,
};

/** Check one frame's data for its path: what to keep, and what was set aside on the way. */
export function checkFrame(path: string, data: unknown): FrameCheck {
  const check = CHECKS[path];
  if (!check) return { ok: true, data, setAside: [] };
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: `its data was ${kindOf(data)}` };
  }
  setAside = [];
  try {
    const r = check.safeParse(data);
    if (!r.success) {
      const issue = r.error.issues[0];
      const at = issue?.path.length ? issue.path.join(".") : "its data";
      return { ok: false, reason: `${at} was not what it needs (${issue?.message ?? "invalid"})` };
    }
    return { ok: true, data: r.data, setAside };
  } finally {
    setAside = [];
  }
}
