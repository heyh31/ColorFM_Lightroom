/**
 * 3D LUT baking.
 *
 * Every entry samples the grid on sRGB-encoded values and leaves intermediate
 * values unclamped: the table stores what the transform produced, and clamping
 * happens when a pixel is written.
 *
 * Baking is a batch over grid nodes; spreading one across cores is the caller's
 * decision, not this module's.
 */

import type { Params } from "../params.js";
import { transferBatch } from "../mlp.js";
import { blendExtrapolate, createLut, identityLut, lutEntries, type Lut3D } from "./table.js";

/** Points per block: small enough that the plane buffers stay cache-resident. */
const TILE = 1024;

/**
 * Bakes the grid, with the user's Amount folded into the result.
 *
 * `strength` is the Amount slider: 0 gives the identity table, 1 the raw bake,
 * above 1 extrapolates past it. Blending the table instead of the pixels keeps
 * the per-pixel loop a plain lookup, so moving the slider re-blends 36 k entries
 * rather than walking the frame again.
 *
 * Evaluation is block-wise: `transferBatch` keeps one plane per hidden unit, so
 * a 65³ grid evaluated in one go would hold ~20 MB of planes. Blocks of
 * {@link TILE} nodes bound that to a few hundred kilobytes, and the values are
 * identical either way — the batch is the same arithmetic, only chunked.
 */
export function bake(params: Params, size: number, strength = 1): Lut3D {
  if (!(size >= 2)) throw new RangeError("LUT size must be at least 2");
  const count = lutEntries(size);
  const n = size - 1;
  const data = new Float32Array(count * 3);

  for (let start = 0; start < count; start += TILE) {
    const stop = Math.min(start + TILE, count);
    const samples = new Float32Array((stop - start) * 3);
    let s = 0;
    for (let i = start; i < stop; i += 1) {
      samples[s++] = (i % size) / n;
      samples[s++] = (Math.floor(i / size) % size) / n;
      samples[s++] = Math.floor(i / (size * size)) / n;
    }
    data.set(transferBatch(params, samples), start * 3);
  }

  const table = createLut(size, data);
  if (Math.abs(strength - 1) < Number.EPSILON) return table;
  return blendExtrapolate(identityLut(size), table, strength);
}
