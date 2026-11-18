/**
 * Applying a {@link Params} set to a whole TIFF.
 *
 * Kept in the library rather than in the engine so the CLI, the examples and
 * the service all run exactly the same code path.
 */

import { ColorfmError } from "./error.js";
import { applyInPlace, applyInPlaceStrength, bake, type Lut3D } from "./lut/index.js";
import { transferBatch } from "./mlp.js";
import type { Params } from "./params.js";
import {
  DEFAULT_BLOCK_ROWS,
  runRows,
  transform,
  transformWithCancel,
  type CancelToken,
  type ImageInfo,
  type RowBand,
  type StripTransform,
} from "./io/tiff.js";

/** How the transform reaches the pixels. */
export type Apply =
  /** Bake a 3D LUT and interpolate. This is the production path. */
  | { readonly kind: "lut"; readonly grid: number }
  /** Evaluate the two MLPs per pixel: exact but slower, used as the reference. */
  | { readonly kind: "direct" };

/** Renders `src` into `dst` with the given parameters. */
export function render(src: string, dst: string, params: Params, apply: Apply): ImageInfo {
  if (apply.kind === "lut") {
    return applyLut(src, dst, bake(params, apply.grid));
  }
  return applyDirect(src, dst, params);
}

/** The LUT transform, with the strength folded into the per-pixel blend. */
function lutTransform(table: Lut3D, strength: number): StripTransform {
  return (pixels) => {
    if (strength === 1) applyInPlace(table, pixels);
    else applyInPlaceStrength(table, pixels, strength);
  };
}

/**
 * Applies an already-baked LUT. Split out so callers can time, and cache, the
 * bake separately from the per-pixel work.
 */
export function applyLut(src: string, dst: string, table: Lut3D): ImageInfo {
  return transform(src, dst, DEFAULT_BLOCK_ROWS, lutTransform(table, 1));
}

/** {@link applyLut} with cooperative cancellation, checked per strip. */
export function applyLutWithCancel(src: string, dst: string, table: Lut3D, cancel: CancelToken): ImageInfo {
  return transformWithCancel(src, dst, DEFAULT_BLOCK_ROWS, cancel, lutTransform(table, 1));
}

/** {@link applyLutWithCancel} with a strength in `[0,1]`. */
export function applyLutWithCancelStrength(
  src: string,
  dst: string,
  table: Lut3D,
  strength: number,
  cancel: CancelToken,
): ImageInfo {
  return transformWithCancel(src, dst, DEFAULT_BLOCK_ROWS, cancel, lutTransform(table, strength));
}

/**
 * Applies a baked table to one band of rows inside a copy of the source.
 *
 * The batch primitive the engine hands to each of its workers: core decides what
 * to compute, the caller decides how many bands run at once.
 */
export function applyLutToRows(
  src: string,
  dst: string,
  rows: RowBand,
  table: Lut3D,
  cancel: CancelToken,
): void {
  runRows(src, dst, DEFAULT_BLOCK_ROWS, rows, cancel, lutTransform(table, 1));
}

/** Evaluates the MLPs per pixel, with no intermediate approximation. */
export function applyDirect(src: string, dst: string, params: Params): ImageInfo {
  return transform(src, dst, DEFAULT_BLOCK_ROWS, (pixels) => {
    pixels.set(transferBatch(params, pixels));
  });
}

/**
 * {@link applyDirect} with a strength in `[0,2]`:
 * `out = src + (graded - src) * s`. Above 1 this over-drives the grade, like
 * the LUT path.
 */
export function applyDirectWithCancelStrength(
  src: string,
  dst: string,
  params: Params,
  strength: number,
  cancel: CancelToken,
): ImageInfo {
  const t = clamp(strength, 0, 2);
  return transformWithCancel(src, dst, DEFAULT_BLOCK_ROWS, cancel, (pixels) => {
    const graded = transferBatch(params, pixels);
    for (let i = 0; i < pixels.length; i += 1) {
      pixels[i] = Math.fround(pixels[i] + Math.fround(Math.fround(graded[i] - pixels[i]) * t));
    }
  });
}

/** {@link applyDirect} with cooperative cancellation, checked per strip. */
export function applyDirectWithCancel(
  src: string,
  dst: string,
  params: Params,
  cancel: CancelToken,
): ImageInfo {
  return transformWithCancel(src, dst, DEFAULT_BLOCK_ROWS, cancel, (pixels) => {
    pixels.set(transferBatch(params, pixels));
  });
}

/** `f32::clamp`, with NaN falling back to the low bound. */
function clamp(value: number, low: number, high: number): number {
  const v = Math.fround(value);
  if (!(v >= low)) return low;
  return v > high ? high : v;
}

export { ColorfmError };
