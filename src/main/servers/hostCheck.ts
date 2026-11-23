import { isIP } from "node:net";
import { nameKey } from "@shared/keys";

/**
 * THE HOST A REQUEST NAMES, CHECKED (the one home for both of the app's servers, the agents'
 * and Display on other screens'). A web page can point a name it controls at this machine (DNS
 * rebinding) and have a browser send requests here, but it can't make the browser name a host
 * other than its own: a request whose Host is a public name came from such a page.
 *
 * - "loopback": only this machine's names (the agents' server on its localhost bind).
 * - "network": an address, a bare machine name, or a name only a local network resolves
 *   (.local and the like), the names a tablet on the network opens.
 */

const LOCAL_SUFFIXES = [".local", ".lan", ".home", ".internal", ".home.arpa", ".localhost"];

/** The name in a Host header, without its port or an IPv6 address's brackets, lowercased. */
export function hostName(header: string | undefined): string {
  const h = nameKey(header ?? "");
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : "";
  }
  return h.split(":")[0];
}

export function hostAllowed(header: string | undefined, reach: "loopback" | "network"): boolean {
  const name = hostName(header);
  if (!name) return false;
  if (reach === "loopback") return name === "127.0.0.1" || name === "localhost";
  if (isIP(name) !== 0 || name === "localhost" || !name.includes(".")) return true;
  return LOCAL_SUFFIXES.some((s) => name.endsWith(s));
}
