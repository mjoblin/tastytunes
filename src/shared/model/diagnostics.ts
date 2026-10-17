// The device connection and what the app can show about it: discovery, the diagnostics
// drawer's logs and frames, updates and firmware, the Requests console, and the ring
// bounds main keeps and the renderer mirrors.

import type { SmoipFrame } from "../smoip";

// ------------------------------------------------------------------- connection

export type ConnectionState =
  | { phase: "idle" }
  | { phase: "connecting"; host: string; attempt: number; demo?: boolean }
  | { phase: "connected"; host: string; demo?: boolean }
  | { phase: "disconnected"; host: string; reason: string; reconnecting: boolean; demo?: boolean };

export interface DiscoveredDevice {
  host: string;
  friendlyName: string;
  model: string;
  udn: string;
  descriptionUrl: string;
}

// ------------------------------------------------------------------ diagnostics

export interface LogEntry {
  at: number;
  level: "info" | "warn" | "error";
  scope: string;
  text: string;
}

export interface FrameEntry {
  at: number;
  dir: "in" | "out";
  frame: SmoipFrame;
}

/** A newer GitHub release than the running version (stage-1 update awareness). */
export interface UpdateInfo {
  /** Bare version, no leading v. */
  version: string;
  /** Release page to open in the browser. */
  url: string;
}

/**
 * The self-update consent flow (Sparkle-style). Nothing downloads or installs
 * without an explicit user action at each step:
 * idle → available —[user: Download]→ downloading → downloaded —[user: Restart
 * now, or silently on next quit]→ installed. `canDownload` is false in
 * unpackaged/dev builds, where "available" only offers the release page.
 */
export interface UpdateState {
  phase: "idle" | "available" | "downloading" | "downloaded" | "error";
  /** Version on offer (bare, no leading v); null while idle. */
  version: string | null;
  /** Download progress 0–100 while downloading. */
  percent: number | null;
  /** In-app download/install possible (packaged build with a release feed). */
  canDownload: boolean;
  /** Release page — always available as the manual path. */
  url: string;
  /** Human-readable failure when phase === 'error'. */
  error: string | null;
}

/**
 * Outcome of a user-initiated release check (the Updates tab's Check now
 * button). 'update' also lands through the normal updateState push — the
 * result exists so the UI can say "nothing new" or show the failure.
 */
export type UpdateCheckResult =
  { status: "update"; version: string } | { status: "none" } | { status: "error"; error: string };

/**
 * Streamer FIRMWARE status, camelCased from the read-only /system/update push
 * (raw SystemUpdate in smoip.ts). Distinct from UpdateState above, which is the
 * APP's own self-update flow. PASSIVE ONLY — the streamer reports its own
 * self-check; TastyTunes surfaces it but never triggers a check or an install
 * (that stays the user's job via the Cambridge Audio app or the streamer's web
 * admin). There is deliberately no command to change any of this.
 */
export interface FirmwareStatus {
  updateAvailable: boolean;
  updating: boolean;
  earlyUpdate: boolean;
}

// ------------------------------------------------------------ requests console

/** One outbound HTTP request from the main process, for the diagnostics drawer. */
export interface NetRequestEntry {
  id: number;
  at: number;
  /** Short service tag: lrclib, musicbrainz, wikidata, wikipedia, listenbrainz, github, art. */
  service: string;
  method: string;
  url: string;
  /** HTTP status once a response arrived; null while pending. */
  status: number | null;
  /** Round-trip ms once settled; null while pending. */
  ms: number | null;
  /** Transport failure — no response at all (DNS, timeout, refused). */
  error: boolean;
}

/**
 * Rings the main process keeps AND the renderer mirrors (2026-08-16, one
 * number each): the diagnostics drawer's frame and log rings, the Requests
 * console's ring, and the recently-played log. The renderer's copy trims to
 * the same bound so a re-opened drawer shows exactly what main holds; the
 * Recently Played footer quotes MAX_RECENTS rather than a literal.
 */
export const FRAME_RING_SIZE = 300;
export const LOG_RING_SIZE = 300;
export const NET_RING_SIZE = 200;
export const MAX_RECENTS = 200;
