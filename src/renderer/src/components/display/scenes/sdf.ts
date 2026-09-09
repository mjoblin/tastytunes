/**
 * SIGNED DISTANCE FIELDS FROM A COVERAGE MASK.
 *
 * Text drawn to a canvas and used as a texture goes soft the moment it is magnified: the
 * sampler blurs the alpha edge. A distance field stores, per texel, how far the nearest
 * edge is; the shader thresholds that with a smoothstep, so the edge stays crisp at any
 * size and the texture can be far smaller than the picture it draws. This is the classic
 * 8SSEDT (eight-point signed sequential Euclidean distance transform): two sweeps over the
 * grid carrying the offset to the nearest seed, run once for the inside and once for the
 * outside; the field is their difference. Dependency free, a few milliseconds for a
 * sign-sized mask, and exact to within a texel.
 */

const FAR = 1 << 14;

/**
 * Distance from every texel on `side` of the mask to the nearest texel on the other side
 * (0 on the other side's own texels). The grid is padded by one texel whose offset is so
 * large it never wins, so the inner loops carry no bounds checks.
 */
function sweep(mask: Uint8Array, w: number, h: number, side: 0 | 1, out: Float32Array): void {
  const W = w + 2;
  const H = h + 2;
  const dx = new Int32Array(W * H).fill(2 * FAR);
  const dy = new Int32Array(W * H).fill(2 * FAR);
  for (let y = 0; y < h; y++) {
    const row = (y + 1) * W + 1;
    const src = y * w;
    for (let x = 0; x < w; x++) {
      const k = row + x;
      if (mask[src + x] !== side) {
        dx[k] = 0;
        dy[k] = 0;
      } else {
        dx[k] = FAR;
        dy[k] = FAR;
      }
    }
  }
  let i = 0;
  let j = 0;
  let cx = 0;
  let cy = 0;
  let bx = 0;
  let by = 0;
  let best = 0;
  let d = 0;
  // the seed nearest to a neighbour, seen from here, is the neighbour's offset plus the step
  for (let y = 1; y <= h; y++) {
    i = y * W + 1;
    for (let x = 1; x <= w; x++, i++) {
      bx = dx[i];
      by = dy[i];
      best = bx * bx + by * by;
      j = i - 1;
      cx = dx[j] - 1;
      cy = dy[j];
      d = cx * cx + cy * cy;
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
      j = i - W;
      cx = dx[j];
      cy = dy[j] - 1;
      d = cx * cx + cy * cy;
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
      j = i - W - 1;
      cx = dx[j] - 1;
      cy = dy[j] - 1;
      d = cx * cx + cy * cy;
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
      j = i - W + 1;
      cx = dx[j] + 1;
      cy = dy[j] - 1;
      d = cx * cx + cy * cy;
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
      dx[i] = bx;
      dy[i] = by;
    }
    i = y * W + w;
    for (let x = w; x >= 1; x--, i--) {
      j = i + 1;
      cx = dx[j] + 1;
      cy = dy[j];
      if (cx * cx + cy * cy < dx[i] * dx[i] + dy[i] * dy[i]) {
        dx[i] = cx;
        dy[i] = cy;
      }
    }
  }
  for (let y = h; y >= 1; y--) {
    i = y * W + w;
    for (let x = w; x >= 1; x--, i--) {
      bx = dx[i];
      by = dy[i];
      best = bx * bx + by * by;
      j = i + 1;
      cx = dx[j] + 1;
      cy = dy[j];
      d = cx * cx + cy * cy;
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
      j = i + W;
      cx = dx[j];
      cy = dy[j] + 1;
      d = cx * cx + cy * cy;
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
      j = i + W - 1;
      cx = dx[j] - 1;
      cy = dy[j] + 1;
      d = cx * cx + cy * cy;
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
      j = i + W + 1;
      cx = dx[j] + 1;
      cy = dy[j] + 1;
      d = cx * cx + cy * cy;
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
      dx[i] = bx;
      dy[i] = by;
    }
    i = y * W + 1;
    for (let x = 1; x <= w; x++, i++) {
      j = i - 1;
      cx = dx[j] - 1;
      cy = dy[j];
      if (cx * cx + cy * cy < dx[i] * dx[i] + dy[i] * dy[i]) {
        dx[i] = cx;
        dy[i] = cy;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    const row = (y + 1) * W + 1;
    const dst = y * w;
    for (let x = 0; x < w; x++) {
      const k = row + x;
      out[dst + x] = Math.sqrt(dx[k] * dx[k] + dy[k] * dy[k]);
    }
  }
}

/**
 * Turn a coverage mask (1 inside the shape, 0 outside) into a distance field of bytes:
 * 128 on the edge, rising inside and falling outside, saturating `spread` texels away.
 * `flipRows` writes the first mask row last, for a texture whose v axis runs upward.
 */
export function coverageToSdf(
  mask: Uint8Array,
  w: number,
  h: number,
  spread: number,
  out: Uint8Array = new Uint8Array(w * h),
  flipRows = false,
): Uint8Array {
  const toEdgeFromInside = new Float32Array(w * h);
  const toEdgeFromOutside = new Float32Array(w * h);
  sweep(mask, w, h, 1, toEdgeFromInside);
  sweep(mask, w, h, 0, toEdgeFromOutside);
  const scale = 127 / spread;
  for (let y = 0; y < h; y++) {
    const row = flipRows ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const sd = toEdgeFromInside[i] - toEdgeFromOutside[i];
      out[row * w + x] = Math.max(0, Math.min(255, Math.round(128 + sd * scale)));
    }
  }
  return out;
}
