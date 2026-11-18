/**
 * Trilinear LUT lookup: single point, in place, batched and chunked.
 *
 * Interpolation is a gather plus eight weighted sums, so there is nothing to
 * factor out per batch beyond hoisting the table constants. Everything below
 * funnels into one range loop that allocates nothing per pixel and unrolls the
 * eight corners in accumulation order: a per-pixel helper call is measurably
 * slower, so the loop is written out instead of shared per point.
 */

import type { RGB } from "../mlp.js";
import type { Lut3D } from "./table.js";

/** Scratch for one result, so a single lookup never allocates. */
const pointScratch = new Float32Array(3);

/** Reused copy of the source, for the strength path. */
let strengthScratch = new Float32Array(0);

/** Trilinear lookup for one colour. Input is clamped to `[0,1]`. */
export function apply(lut: Lut3D, rgb: RGB): RGB {
  pointScratch[0] = rgb[0];
  pointScratch[1] = rgb[1];
  pointScratch[2] = rgb[2];
  transformRange(lut, pointScratch, 0, 3);
  return [pointScratch[0], pointScratch[1], pointScratch[2]];
}

/**
 * Applies the LUT to an interleaved RGB buffer in place — the streaming form
 * the TIFF transform uses, where the strip buffer is both input and output.
 */
export function applyInPlace(lut: Lut3D, pixels: Float32Array): void {
  transformRange(lut, pixels, 0, pixels.length);
}

/**
 * Applies the LUT at partial strength: `out = src + (lut(src) - src) * t`,
 * matching Lightroom's Amount semantics.
 */
export function applyInPlaceStrength(lut: Lut3D, pixels: Float32Array, strength: number): void {
  const t = clamp01(strength);
  if (t >= 1) {
    applyInPlace(lut, pixels);
    return;
  }
  if (t <= 0) return;

  if (strengthScratch.length < pixels.length) strengthScratch = new Float32Array(pixels.length);
  const source = strengthScratch.subarray(0, pixels.length);
  source.set(pixels);

  transformRange(lut, pixels, 0, pixels.length);
  for (let i = 0; i < pixels.length; i += 1) {
    const src = source[i];
    pixels[i] = Math.fround(src + Math.fround(Math.fround(pixels[i] - src) * t));
  }
}

/**
 * {@link apply} over a buffer, written into `out`.
 *
 * Takes a caller-owned buffer so a streaming writer can reuse one strip buffer
 * instead of allocating per call.
 */
export function applyInto(lut: Lut3D, samples: Float32Array, out: Float32Array): void {
  if (samples.length !== out.length) {
    throw new RangeError("sample and output buffers must match");
  }
  if (out !== samples) out.set(samples);
  transformRange(lut, out, 0, out.length);
}

/** Sequential batch lookup into a fresh buffer. */
export function applyBatch(lut: Lut3D, samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length);
  applyInto(lut, samples, out);
  return out;
}

/**
 * {@link applyBatch} with the samples split into `threads` contiguous runs.
 * Output order matches input order and the values match the sequential path.
 */
export function applyParallel(lut: Lut3D, samples: Float32Array, threads: number): Float32Array {
  const out = new Float32Array(samples.length);
  const workers = Math.max(1, Math.floor(threads) || 1);
  const pixels = Math.floor(samples.length / 3);
  const chunk = Math.ceil(pixels / workers);
  if (chunk === 0) return out;

  for (let start = 0; start < pixels; start += chunk) {
    const stop = Math.min(start + chunk, pixels);
    applyInto(lut, samples.subarray(start * 3, stop * 3), out.subarray(start * 3, stop * 3));
  }
  return out;
}

/**
 * The one trilinear loop. Transforms `pixels[start..end)` in place.
 *
 * The cell is located by clamping to `[0,1]`, scaling by `size - 1` and taking
 * the integer part; the fraction feeds the eight corner weights. Products and
 * accumulation keep the same order as the mathematical definition, so the
 * unrolling cannot change a single bit.
 */
function transformRange(lut: Lut3D, pixels: Float32Array, start: number, end: number): void {
  const size = lut.size;
  const data = lut.data;
  const scale = Math.fround(size - 1);
  const last = size - 2;
  const strideR = 3;
  const strideG = size * 3;
  const strideB = size * size * 3;

  for (let p = start; p < end; p += 3) {
    const r = pixels[p];
    const g = pixels[p + 1];
    const b = pixels[p + 2];

    // clamp to [0,1] (NaN becomes 0), then scale into grid units
    const cr = r > 0 ? (r > 1 ? 1 : r) : 0;
    const cg = g > 0 ? (g > 1 ? 1 : g) : 0;
    const cb = b > 0 ? (b > 1 ? 1 : b) : 0;
    const pr = Math.fround(cr * scale);
    const pg = Math.fround(cg * scale);
    const pb = Math.fround(cb * scale);

    // grid cells are non-negative and below `size`, so truncation is flooring
    let i0 = pr | 0;
    let i1 = pg | 0;
    let i2 = pb | 0;
    if (i0 > last) i0 = last;
    if (i1 > last) i1 = last;
    if (i2 > last) i2 = last;

    const f0 = Math.fround(pr - i0);
    const f1 = Math.fround(pg - i1);
    const f2 = Math.fround(pb - i2);
    const g0 = Math.fround(1 - f0);
    const g1 = Math.fround(1 - f1);
    const g2 = Math.fround(1 - f2);

    const w000 = Math.fround(Math.fround(g0 * g1) * g2);
    const w100 = Math.fround(Math.fround(f0 * g1) * g2);
    const w010 = Math.fround(Math.fround(g0 * f1) * g2);
    const w110 = Math.fround(Math.fround(f0 * f1) * g2);
    const w001 = Math.fround(Math.fround(g0 * g1) * f2);
    const w101 = Math.fround(Math.fround(f0 * g1) * f2);
    const w011 = Math.fround(Math.fround(g0 * f1) * f2);
    const w111 = Math.fround(Math.fround(f0 * f1) * f2);

    const base = i2 * strideB + i1 * strideG + i0 * strideR;
    let red = 0;
    let green = 0;
    let blue = 0;
    let at = base;

    red = Math.fround(red + Math.fround(w000 * data[at]));
    green = Math.fround(green + Math.fround(w000 * data[at + 1]));
    blue = Math.fround(blue + Math.fround(w000 * data[at + 2]));

    at = base + strideR;
    red = Math.fround(red + Math.fround(w100 * data[at]));
    green = Math.fround(green + Math.fround(w100 * data[at + 1]));
    blue = Math.fround(blue + Math.fround(w100 * data[at + 2]));

    at = base + strideG;
    red = Math.fround(red + Math.fround(w010 * data[at]));
    green = Math.fround(green + Math.fround(w010 * data[at + 1]));
    blue = Math.fround(blue + Math.fround(w010 * data[at + 2]));

    at = base + strideG + strideR;
    red = Math.fround(red + Math.fround(w110 * data[at]));
    green = Math.fround(green + Math.fround(w110 * data[at + 1]));
    blue = Math.fround(blue + Math.fround(w110 * data[at + 2]));

    at = base + strideB;
    red = Math.fround(red + Math.fround(w001 * data[at]));
    green = Math.fround(green + Math.fround(w001 * data[at + 1]));
    blue = Math.fround(blue + Math.fround(w001 * data[at + 2]));

    at = base + strideB + strideR;
    red = Math.fround(red + Math.fround(w101 * data[at]));
    green = Math.fround(green + Math.fround(w101 * data[at + 1]));
    blue = Math.fround(blue + Math.fround(w101 * data[at + 2]));

    at = base + strideB + strideG;
    red = Math.fround(red + Math.fround(w011 * data[at]));
    green = Math.fround(green + Math.fround(w011 * data[at + 1]));
    blue = Math.fround(blue + Math.fround(w011 * data[at + 2]));

    at = base + strideB + strideG + strideR;
    red = Math.fround(red + Math.fround(w111 * data[at]));
    green = Math.fround(green + Math.fround(w111 * data[at + 1]));
    blue = Math.fround(blue + Math.fround(w111 * data[at + 2]));

    pixels[p] = red;
    pixels[p + 1] = green;
    pixels[p + 2] = blue;
  }
}

/** `f32::clamp(0, 1)`, with NaN mapped to 0. */
function clamp01(value: number): number {
  const v = Math.fround(value);
  if (!(v > 0)) return 0;
  return v > 1 ? 1 : v;
}
