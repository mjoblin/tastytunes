/**
 * WHETHER THE MAC ASKS BEFORE AN APP REACHES THE LOCAL NETWORK (0.12.0). From macOS 15 an app
 * reaches the local network only once its owner allows it, and a declined prompt drops unicast
 * and multicast alike, silently (live-hit on the release dmg, 2026-08-04; electron-builder.yml's
 * NSLocalNetworkUsageDescription): discovery finds nothing and an IP typed by hand never
 * answers. The welcome screen names the setting only where it exists.
 */
export function hasLocalNetworkPrivacy(platform: string, systemVersion: string): boolean {
  if (platform !== "darwin") return false;
  const major = Number.parseInt(systemVersion, 10);
  return Number.isFinite(major) && major >= 15;
}
