// A COVER'S PIXELS, one home (0.16.0's hygiene: the accent and the scenes' palette each drew the
// cover themselves). The art comes as a data URL fetched through main, so the canvas is never
// tainted; it is drawn at size × size and read as a canvas reads it, RGBA. The accent
// (useArtAccent) reads 32, the scenes' palette 40. Null when the canvas has no 2D context.
export async function coverPixels(
  dataUrl: string,
  size: number,
): Promise<Uint8ClampedArray | null> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
}
