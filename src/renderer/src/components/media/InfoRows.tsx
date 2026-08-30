import { useState } from "react";
import { Copy, Check } from "lucide-react";
import {
  describeProfileNote,
  fmtBytes,
  type MediaNode,
  type MediaServerProfile,
} from "@shared/model";
import type { StreamInfo } from "@shared/model";

/**
 * The Info surface's building blocks, shared between the Info modal (any
 * media, from every track menu) and the context drawer's Stream tab (what is
 * playing now). One definition per derivation — the stream, format and source
 * sections must read identically wherever they appear.
 */

export type Row = [label: string, value: React.ReactNode];

export function Section({ title, rows }: { title: string; rows: Row[] }): React.JSX.Element | null {
  const shown = rows.filter(
    ([, v]) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0),
  );
  if (shown.length === 0) return null;
  return (
    <div data-info-section={title.toLowerCase()}>
      <div className="microlabel mb-1.5">{title}</div>
      <dl className="grid grid-cols-[112px_1fr] gap-x-4 gap-y-1 text-[12.5px]">
        {shown.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-faint truncate">{label}</dt>
            <dd className="text-ink min-w-0 break-words" data-info-field={label}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export const mono = (v: string | null | undefined): React.ReactNode =>
  v ? <span className="font-mono text-[11px] text-dim break-all">{v}</span> : null;

/**
 * A mono value with a copy affordance — the URL or id someone pastes into a
 * bug report, an agent prompt, a browser (user ask, 2026-08-16). The app
 * doesn't allow free text selection, on purpose; this is the deliberate
 * exception, one value at a time. Feedback is in place (the icon becomes a
 * check for a beat) — a toast would double-feedback something under the
 * cursor.
 */
export function CopyableMono({
  value,
  label,
}: {
  value: string;
  label: string;
}): React.JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <span className="inline-flex items-center gap-2 min-w-0 max-w-full">
      <span className="font-mono text-[11px] text-dim break-all">{value}</span>
      <button
        data-tip={done ? "Copied" : `Copy ${label}`}
        aria-label={`Copy ${label}`}
        data-info-copy-value={label}
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
        // above and right-aligned: the value sits at the right of a scroll
        // container, and a centered/below tip clips at its edge
        className="tip-top tip-end shrink-0 p-1 rounded text-faint hover:text-ink hover:bg-veil2"
      >
        {done ? <Check size={11} /> : <Copy size={11} />}
      </button>
    </span>
  );
}

const khzOf = (hz: number): string => `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`;

/** The stream, as the streamer reports it (what is playing NOW). */
export function streamRows(stream: StreamInfo): Row[] {
  return [
    ["Source", stream.source],
    ["Station", stream.station],
    ["Codec", stream.codec],
    ["Sample rate", stream.sampleRate ? khzOf(stream.sampleRate) : null],
    ["Bit depth", stream.bitDepth ? `${stream.bitDepth}-bit` : null],
    ["Bitrate", stream.bitrate ? `${Math.round(stream.bitrate / 1000)} kbps` : null],
    ["Format", !stream.sampleRate && !stream.codec ? stream.sampleFormat : null],
    ["Encoding", stream.encoding],
    ["Lossless", stream.lossless == null ? null : stream.lossless ? "yes" : "no"],
    ["MQA", stream.mqa],
    [
      "Queue",
      stream.queuePosition != null && stream.queueLength != null
        ? `${stream.queuePosition} of ${stream.queueLength}`
        : null,
    ],
    ["Presettable", stream.presettable == null ? null : stream.presettable ? "yes" : "no"],
    ["Controls", stream.controls.length > 0 ? stream.controls.join(", ") : null],
    ["Radio id", mono(stream.radioId)],
    ["Playback", [stream.playbackSource, stream.playbackClass].filter(Boolean).join(" · ") || null],
  ];
}

/** A track's own file format facts, from the library index. */
export function trackFormatRows(node: MediaNode): Row[] {
  const f = node.format;
  if (node.isContainer || !f) return [];
  return [
    ["Codec", f.codec],
    ["Bit depth", f.bits ? `${f.bits}-bit` : null],
    ["Sample rate", f.rate ? khzOf(f.rate) : null],
    ["Bitrate", f.kbps ? `${f.kbps} kbps` : null],
    ["Channels", f.channels ?? null],
    ["File size", f.sizeBytes ? fmtBytes(f.sizeBytes) : null],
  ];
}

/** Where it came from: server, ids, and what the index learned crawling it. */
export function sourceRows(
  node: MediaNode,
  serverName: string | null,
  serverProfile: MediaServerProfile | null | undefined,
): Row[] {
  // Plain words: how the library was read, and — only when it differed from
  // the norm — where the albums came from. The class-search mechanic stays
  // in the JSON / MCP profile; a user needs "by search" or "by browsing".
  const indexed = serverProfile
    ? [
        serverProfile.strategy === "search" ? "by search" : "by browsing",
        serverProfile.albumsFrom === "tracks"
          ? "albums assembled from tracks"
          : serverProfile.albumsFrom === "browse"
            ? "albums found by browsing"
            : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  return [
    ["Server", serverName ?? node.serverName ?? null],
    ["Object id", node.id ? <CopyableMono value={node.id} label="object id" /> : null],
    ["Parent id", mono(node.parentId)],
    ["Class", node.id ? mono(node.upnpClass) : null],
    ["Art", node.artUrl ? <CopyableMono value={node.artUrl} label="art URL" /> : null],
    ["Indexed", indexed],
    ...(serverProfile && serverProfile.notes.length > 0
      ? serverProfile.notes.map((n, i): Row => [i === 0 ? "Notes" : "", describeProfileNote(n)])
      : []),
  ];
}
