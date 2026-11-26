/**
 * A PICTURE'S TYPE FROM ITS FIRST BYTES: the one home for telling a picture's format by its
 * signature, for a server that calls every file octet-stream (main/lookups/artFetch), a chosen
 * picture's kept copy (the export) and the picture inside an audio file, whose tags' own MIME
 * field is often wrong or empty (main/lookups/embeddedArt). Null for anything else.
 */
export function pictureType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")))
    return "image/svg+xml";
  return null;
}
