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
 * than an approximation. Accumulation is row-major and in a fixed order, so
 * results do not drift between runs.
 *
 * Two entry points share one formula:
 *
 * * {@link transfer} — one pixel at a time, values stay in locals.
 * * {@link transferBatch} — the same maths for many pixels, one layer at a
 *   time with the inner loop over the batch. Produces the same values as
 *   calling {@link transfer} per pixel; used by the LUT baker.
 *
 * The weights arrive as rows of f32-precision numbers (what the model emits,
 * see `Kernels`) and the arithmetic runs in double, so the only rounding is the
 * one the model already applied to its own weights.
 */

import { MAT_DIM, type Kernels, type Params } from "./params.js";

/** One sRGB-encoded colour, components in 0..1. */
export type RGB = [number, number, number];

const HIDDEN = MAT_DIM;

/** Input of the first layer, including the constant channel. */
const inputScratch = new Float64Array(4);
/** Two hidden buffers, alternated so a layer never reads what it writes. */
const hiddenA = new Float64Array(HIDDEN);
const hiddenB = new Float64Array(HIDDEN);
/** Output of the last layer of one stage. */
const outScratch = new Float64Array(3);

/** Swish: x * sigmoid(x), written as x / (1 + e^-x). */
function swish(x: number): number {
  return x / (1 + Math.exp(-x));
}

/** `out = weights * input` for one layer, accumulating rows in ascending order. */
function linear(input: ArrayLike<number>, weights: readonly number[][], out: Float64Array): void {
  for (let c = 0; c < out.length; c += 1) out[c] = 0;
  for (let r = 0; r < weights.length; r += 1) {
    const a = input[r];
    const row = weights[r];
    for (let c = 0; c < row.length; c += 1) {
      out[c] += a * row[c];
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

  linear(inputScratch, kernels.k1, hiddenA);
  for (let i = 0; i < HIDDEN; i += 1) hiddenA[i] = swish(hiddenA[i]);
  linear(hiddenA, kernels.k2, hiddenB);
  for (let i = 0; i < HIDDEN; i += 1) hiddenB[i] = swish(hiddenB[i]);
  linear(hiddenB, kernels.k3, hiddenA);
  for (let i = 0; i < HIDDEN; i += 1) hiddenA[i] = swish(hiddenA[i]);
  linear(hiddenA, kernels.k4, outScratch);

  return [outScratch[0], outScratch[1], outScratch[2]];
}

/** Full transform for a single pixel. `rgb` is sRGB-encoded, 0..1. */
export function transfer(params: Params, rgb: RGB): RGB {
  const d1 = evalStage(params.content, rgb, 0);
  const y1: RGB = [rgb[0] + d1[0], rgb[1] + d1[1], rgb[2] + d1[2]];
  const d2 = evalStage(params.style, y1, 1);
  return [y1[0] - d2[0], y1[1] - d2[1], y1[2] - d2[2]];
}

/**
 * One layer for a whole plane batch: one plane per output row, `count` values
 * each.
 *
 * The weight is read once per row and column and then reused across the batch,
 * so the inner loop touches only contiguous buffers — the nested shape costs
 * nothing here.
 */
function linearPlanes(
  inputs: readonly Float64Array[],
  weights: readonly number[][],
  count: number,
): Float64Array[] {
  const outputCount = weights[0].length;
  const outputs: Float64Array[] = [];
  for (let c = 0; c < outputCount; c += 1) outputs.push(new Float64Array(count));

  for (let r = 0; r < weights.length; r += 1) {
    const src = inputs[r];
    const row = weights[r];
    for (let c = 0; c < outputCount; c += 1) {
      const weight = row[c];
      const dst = outputs[c];
      for (let i = 0; i < count; i += 1) {
        dst[i] += weight * src[i];
      }
    }
  }
  return outputs;
}

function activatePlanes(planes: Float64Array[]): void {
  for (const plane of planes) {
    for (let i = 0; i < plane.length; i += 1) plane[i] = swish(plane[i]);
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

  const r = new Float64Array(count);
  const g = new Float64Array(count);
  const b = new Float64Array(count);
  const zeros = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    r[i] = pixels[i * 3];
    g[i] = pixels[i * 3 + 1];
    b[i] = pixels[i * 3 + 2];
  }

  // Content stage: the constant channel is zero.
  let hidden = linearPlanes([r, g, b, zeros], params.content.k1, count);
  activatePlanes(hidden);
  hidden = linearPlanes(hidden, params.content.k2, count);
  activatePlanes(hidden);
  hidden = linearPlanes(hidden, params.content.k3, count);
  activatePlanes(hidden);
  const d1 = linearPlanes(hidden, params.content.k4, count);

  const y1 = [new Float64Array(count), new Float64Array(count), new Float64Array(count)];
  const base = [r, g, b];
  for (let c = 0; c < 3; c += 1) {
    const source = base[c];
    const delta = d1[c];
    const target = y1[c];
    for (let i = 0; i < count; i += 1) target[i] = source[i] + delta[i];
  }

  // Style stage: the constant channel is one.
  const ones = new Float64Array(count).fill(1);
  hidden = linearPlanes([y1[0], y1[1], y1[2], ones], params.style.k1, count);
  activatePlanes(hidden);
  hidden = linearPlanes(hidden, params.style.k2, count);
  activatePlanes(hidden);
  hidden = linearPlanes(hidden, params.style.k3, count);
  activatePlanes(hidden);
  const d2 = linearPlanes(hidden, params.style.k4, count);

  for (let i = 0; i < count; i += 1) {
    out[i * 3] = y1[0][i] - d2[0][i];
    out[i * 3 + 1] = y1[1][i] - d2[1][i];
    out[i * 3 + 2] = y1[2][i] - d2[2][i];
  }
  return out;
}
