// What a failed connection's reason means, in the reader's terms. The socket's reason is the error
// before the close ("connect ECONNREFUSED 10.0.0.5:80", main/device/smoipSocket); the connect
// screen says what it means as a sentence of its own, never the code (writing/REGISTER.md,
// errors). Null when the reason says nothing more useful than "still trying".

const STILL_OFF = "It may be off or in eco standby.";

export function connectTrouble(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (/ECONNREFUSED/.test(reason)) {
    return "Something at that address refused the connection, so it may not be the streamer.";
  }
  if (/Unexpected server response/i.test(reason)) {
    return "Something answered at that address, but not a StreamMagic streamer.";
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(reason)) return "That name isn't known on your network.";
  // unreachable and timed out read the same: either way, nothing there is answering
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ETIMEDOUT|timed out/i.test(reason)) {
    return `Nothing answers at that address. ${STILL_OFF}`;
  }
  return null;
}

export const STILL_TRYING_HINT = STILL_OFF;
