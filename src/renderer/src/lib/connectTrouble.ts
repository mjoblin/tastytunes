// What a failed connection's reason means, in the reader's terms. The socket's reason is the error
// before the close ("connect ECONNREFUSED 10.0.0.5:80", main/device/smoipSocket); the connect
// screen says what it means as a sentence of its own, never the code (writing/REGISTER.md,
// errors). Null when the reason says nothing more useful than "still trying".

const STILL_OFF = "It may be off or in eco standby.";

// A Mac that asks before an app reaches the local network (macOS 15 and later) fails a blocked
// app's connect as no route to host, the error a streamer that is off gives too, so both are
// offered. The setting can also show an app as allowed while still blocking it, which turning it
// off and on clears.
const LOCAL_NETWORK =
  "If it's on, your Mac may be blocking TastyTunes from your local network. Check System Settings › Privacy & Security › Local Network, and if TastyTunes is already on there, turn it off and on.";

export function connectTrouble(
  reason: string | null | undefined,
  opts: { localNetworkPrivacy?: boolean } = {},
): string | null {
  if (!reason) return null;
  if (/ECONNREFUSED/.test(reason)) {
    return "Something at that address refused the connection, so it may not be the streamer.";
  }
  if (/Unexpected server response/i.test(reason)) {
    return "Something answered at that address, but not a StreamMagic streamer.";
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(reason)) return "That name isn't known on your network.";
  // unreachable and timed out read the same: either way, nothing there is answering
  const nothing = `Nothing answers at that address. ${STILL_OFF}`;
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/.test(reason)) {
    return opts.localNetworkPrivacy ? `${nothing} ${LOCAL_NETWORK}` : nothing;
  }
  if (/ETIMEDOUT|timed out/i.test(reason)) return nothing;
  return null;
}

export const STILL_TRYING_HINT = STILL_OFF;
