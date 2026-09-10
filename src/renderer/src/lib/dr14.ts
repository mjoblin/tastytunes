/**
 * TT dynamic range — the "DR" integer of the loudness-war database
 * (dr.loudness-war.info) — ported line-for-line from the reference
 * implementation that community accepts submissions from: dr14_t.meter's
 * compute_dr14 (Simone Riva, GPL-3). The procedure: per channel, split
 * into 3-second blocks; block RMS carries a 2x energy factor (a full-scale
 * sine reads -3 dB); average the loudest 20% of blocks in the power
 * domain; divide the SECOND-highest block peak by that average; the DR is
 * the channel mean of those ratios in dB, rounded to an integer.
 *
 * The reference's quirks are load-bearing and reproduced deliberately —
 * validation (dev/validate-dr.mjs in ops) demands exact integer agreement
 * with the reference source running on identical samples:
 *  - blocks are 60 samples WIDER than 3s at exactly 44100 Hz (delta_fs);
 *  - a tail row is always allocated and stays zero when the track divides
 *    evenly into blocks — and those zeros take part in the sorts;
 *  - the tail slice DROPS THE FINAL SAMPLE (the reference's Y[a : N-1]);
 *  - the second-highest peak index wraps numpy-style, so a sub-3s
 *    single-block track reads its only row;
 *  - a channel is zeroed when its loud-block power sits under the 2^-24
 *    silence floor or its ratio exceeds the 24-bit dynamic range;
 *  - the channel mean rounds half-to-even (Python 3's round()).
 * One divergence, documented: a track whose length is exactly one sample
 * past a block boundary crashes the reference (max of an empty slice);
 * here that tail row simply stays zero.
 */

const AUDIO_MIN = 1 / 2 ** 24;
const MAX_DYNAMIC_24BIT = 20 * Math.log10(2 ** 24);

function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * The album's official DR — the reference's dynamic_range_meter.py sums
 * each track's INTEGER DR and divides by the scanned-track count, rounded
 * half-to-even like everything else. A decoded DR0 track (a silent
 * interlude) counts in the mean; only tracks that failed to decode don't.
 * An album value therefore exists only when EVERY track is measured.
 */
export function albumDr14(trackDrs: readonly number[]): number {
  if (trackDrs.length === 0) return 0;
  return roundHalfEven(trackDrs.reduce((s, v) => s + v, 0) / trackDrs.length);
}

export function computeDr14(channels: readonly Float32Array[], sampleRate: number): number {
  const ch = channels.length;
  if (ch === 0 || channels[0].length === 0) return 0;
  const frames = channels[0].length;
  const deltaFs = sampleRate === 44100 ? 60 : 0;
  const blockSamples = 3 * (sampleRate + deltaFs);
  const segCnt = Math.floor(frames / blockSamples) + 1;

  let drSum = 0;
  for (let c = 0; c < ch; c++) {
    const y = channels[c];
    const rms = new Float64Array(segCnt);
    const peaks = new Float64Array(segCnt);
    let cur = 0;
    for (let i = 0; i < segCnt - 1; i++) {
      const end = cur + blockSamples;
      let sumSq = 0;
      let max = 0;
      for (let k = cur; k < end; k++) {
        const v = y[k];
        sumSq += v * v;
        const a = Math.abs(v);
        if (a > max) max = a;
      }
      rms[i] = Math.sqrt((2 * sumSq) / blockSamples);
      peaks[i] = max;
      cur = end;
    }
    if (cur < frames) {
      const end = frames - 1;
      const n = end - cur;
      if (n > 0) {
        let sumSq = 0;
        let max = 0;
        for (let k = cur; k < end; k++) {
          const v = y[k];
          sumSq += v * v;
          const a = Math.abs(v);
          if (a > max) max = a;
        }
        rms[segCnt - 1] = Math.sqrt((2 * sumSq) / n);
        peaks[segCnt - 1] = max;
      }
    }
    peaks.sort();
    rms.sort();
    let nBlk = Math.floor(segCnt * 0.2);
    if (nBlk === 0) nBlk = 1;
    let rmsSum = 0;
    for (let i = segCnt - nBlk; i < segCnt; i++) rmsSum += rms[i] * rms[i];
    const secondPeak = peaks[segCnt >= 2 ? segCnt - 2 : segCnt - 2 + segCnt];
    let v = -20 * Math.log10(Math.sqrt(rmsSum / nBlk) / secondPeak);
    if (rmsSum < AUDIO_MIN || Math.abs(v) > MAX_DYNAMIC_24BIT) v = 0;
    drSum += v;
  }
  return roundHalfEven(drSum / ch);
}
