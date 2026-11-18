/**
 * Per-pixel transform: two residual MLPs, the same evaluation path the model
 * was trained with.
 *
 * ```text
 * y1 = x  + mlp([x, 0], theta_content)
 * y2 = y1 - mlp([y1, 1], theta_style)
 * ```
 *
 * Every operation is pointwise, which is what makes 3D LUT baking exact rather
 * than an approximation. Accumulation is row-major and in a fixed order, and
 * each product is rounded to f32 before it is added, so results do not drift
 * between builds or platforms.
 *
 * Two entry points share one formula:
 *
 * * {@link transfer} — one pixel at a time, values stay in locals.
 * * {@link transferBatch} — the same maths for many pixels, one layer at a
 *   time with the inner loop over the batch. Produces the same values as
 *   calling {@link transfer} per pixel; used by the LUT baker.
 */

import { swishf } from "./float32.js";
import { MAT_DIM, type Kernels, type Params } from "./params.js";

/** One sRGB-encoded colour, components in 0..1. */
export type RGB = [number, number, number];

const HIDDEN = MAT_DIM;

/** Input of the first layer, including the constant channel. */
const inputScratch = new Float32Array(4);
/** Two hidden buffers, alternated so a layer never reads what it writes. */
const hiddenA = new Float32Array(HIDDEN);
const hiddenB = new Float32Array(HIDDEN);
/** Output of the last layer of one stage. */
const outScratch = new Float32Array(3);

/**
 * `out = weights * input` for one layer, accumulating rows in ascending order
 * and rounding each product to f32 before adding it.
 */
function linear(
  input: Float32Array,
  inputCount: number,
  weights: Float32Array,
  outputCount: number,
  out: Float32Array,
): void {
  for (let c = 0; c < outputCount; c += 1) out[c] = 0;
  for (let r = 0; r < inputCount; r += 1) {
    const a = input[r];
    const row = r * outputCount;
    for (let c = 0; c < outputCount; c += 1) {
      out[c] = out[c] + Math.fround(a * weights[row + c]);
    }
  }
}

/**
 * One stage: `4 -> 16 -> 16 -> 16 -> 3`, Swish between layers and none after
 * the last matmul. `bias` is the constant fourth input channel: 0 for the
 * content stage, 1 for the style stage.
 */
export function evalStage(kernels: Kernels, rgb: RGB, bias: number): RGB {
  inputScratch[0] = rgb[0];
  inputScratch[1] = rgb[1];
  inputScratch[2] = rgb[2];
  inputScratch[3] = bias;

  linear(inputScratch, 4, kernels.k1, HIDDEN, hiddenA);
  for (let i = 0; i < HIDDEN; i += 1) hiddenA[i] = swishf(hiddenA[i]);
  linear(hiddenA, HIDDEN, kernels.k2, HIDDEN, hiddenB);
  for (let i = 0; i < HIDDEN; i += 1) hiddenB[i] = swishf(hiddenB[i]);
  linear(hiddenB, HIDDEN, kernels.k3, HIDDEN, hiddenA);
  for (let i = 0; i < HIDDEN; i += 1) hiddenA[i] = swishf(hiddenA[i]);
  linear(hiddenA, HIDDEN, kernels.k4, 3, outScratch);

  return [outScratch[0], outScratch[1], outScratch[2]];
}

/** Full transform for a single pixel. `rgb` is sRGB-encoded, 0..1. */
export function transfer(params: Params, rgb: RGB): RGB {
  const d1 = evalStage(params.content, rgb, 0);
  const y1: RGB = [Math.fround(rgb[0] + d1[0]), Math.fround(rgb[1] + d1[1]), Math.fround(rgb[2] + d1[2])];
  const d2 = evalStage(params.style, y1, 1);
  return [Math.fround(y1[0] - d2[0]), Math.fround(y1[1] - d2[1]), Math.fround(y1[2] - d2[2])];
}

/** One layer for a whole plane batch: `outputCount` planes of `count` values. */
function linearPlanes(
  inputs: readonly Float32Array[],
  weights: Float32Array,
  outputCount: number,
  count: number,
): Float32Array[] {
  const outputs: Float32Array[] = [];
  for (let c = 0; c < outputCount; c += 1) outputs.push(new Float32Array(count));

  for (let r = 0; r < inputs.length; r += 1) {
    const src = inputs[r];
    const row = r * outputCount;
    for (let c = 0; c < outputCount; c += 1) {
      const weight = weights[row + c];
      const dst = outputs[c];
      for (let i = 0; i < count; i += 1) {
        dst[i] = dst[i] + Math.fround(weight * src[i]);
      }
    }
  }
  return outputs;
}

function activatePlanes(planes: Float32Array[]): void {
  for (const plane of planes) {
    for (let i = 0; i < plane.length; i += 1) plane[i] = swishf(plane[i]);
  }
}

/**
 * {@link transfer} over an interleaved RGB buffer, evaluated plane-wise.
 *
 * `pixels` holds `n` colours as `r0 g0 b0 r1 g1 b1 …`; the returned buffer has
 * the same layout and the same values {@link transfer} produces per pixel.
 */
export function transferBatch(params: Params, pixels: Float32Array): Float32Array {
  const count = Math.floor(pixels.length / 3);
  const out = new Float32Array(count * 3);
  if (count === 0) return out;

  const r = new Float32Array(count);
  const g = new Float32Array(count);
  const b = new Float32Array(count);
  const zeros = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    r[i] = pixels[i * 3];
    g[i] = pixels[i * 3 + 1];
    b[i] = pixels[i * 3 + 2];
  }

  // Content stage: the constant channel is zero.
  let hidden = linearPlanes([r, g, b, zeros], params.content.k1, HIDDEN, count);
  activatePlanes(hidden);
  hidden = linearPlanes(hidden, params.content.k2, HIDDEN, count);
  activatePlanes(hidden);
  hidden = linearPlanes(hidden, params.content.k3, HIDDEN, count);
  activatePlanes(hidden);
  const d1 = linearPlanes(hidden, params.content.k4, 3, count);

  const y1 = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  const base = [r, g, b];
  for (let c = 0; c < 3; c += 1) {
    const source = base[c];
    const delta = d1[c];
    const target = y1[c];
    for (let i = 0; i < count; i += 1) target[i] = Math.fround(source[i] + delta[i]);
  }

  // Style stage: the constant channel is one.
  const ones = new Float32Array(count).fill(1);
  hidden = linearPlanes([y1[0], y1[1], y1[2], ones], params.style.k1, HIDDEN, count);
  activatePlanes(hidden);
  hidden = linearPlanes(hidden, params.style.k2, HIDDEN, count);
  activatePlanes(hidden);
  hidden = linearPlanes(hidden, params.style.k3, HIDDEN, count);
  activatePlanes(hidden);
  const d2 = linearPlanes(hidden, params.style.k4, 3, count);

  for (let i = 0; i < count; i += 1) {
    out[i * 3] = Math.fround(y1[0][i] - d2[0][i]);
    out[i * 3 + 1] = Math.fround(y1[1][i] - d2[1][i]);
    out[i * 3 + 2] = Math.fround(y1[2][i] - d2[2][i]);
  }
  return out;
}
