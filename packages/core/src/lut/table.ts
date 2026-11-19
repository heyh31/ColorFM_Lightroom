/**
 * The LUT type itself: construction, indexing, the identity table and blending.
 *
 * The grid is sampled on **sRGB-encoded** values (`[0,1]^3`), which is the
 * model's own domain — it is trained on 8-bit sRGB images. Do not feed linear
 * values here.
 *
 * Entry order follows the Iridas `.cube` spec: red changes fastest, then
 * green, then blue. `data` is a flat interleaved RGB buffer of `size^3 * 3`
 * floats.
 */

/** A cubic color lookup table. */
export interface Lut3D {
  /** Edge length, at least 2. */
  readonly size: number;
  /** `size^3` interleaved RGB triples, red varying fastest. */
  readonly data: Float32Array;
}

/** Number of table entries for a grid of `size`. */
export function lutEntries(size: number): number {
  return size * size * size;
}

/** Builds a table, checking the two invariants callers rely on. */
export function createLut(size: number, data: Float32Array): Lut3D {
  if (!(size >= 2)) throw new RangeError("LUT size must be at least 2");
  const expected = lutEntries(size) * 3;
  if (data.length !== expected) {
    throw new RangeError(`LUT has ${data.length / 3} entries, expected ${expected / 3} for size ${size}`);
  }
  return { size, data };
}

/** Index of `(r, g, b)` in the flat buffer; red varies fastest. */
export function lutOffset(lut: Lut3D, r: number, g: number, b: number): number {
  return ((b * lut.size + g) * lut.size + r) * 3;
}

/**
 * Identity table: entry `(r, g, b)` maps to `(r/(n-1), g/(n-1), b/(n-1))`.
 * Used as the neutral point for strength blending.
 */
export function identityLut(size: number): Lut3D {
  if (!(size >= 2)) throw new RangeError("LUT size must be at least 2");
  const n = size - 1;
  const data = new Float32Array(lutEntries(size) * 3);
  let i = 0;
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        data[i++] = r / n;
        data[i++] = g / n;
        data[i++] = b / n;
      }
    }
  }
  return { size, data };
}

/**
 * Linear blend with another table, `t = 0` giving `a` and `t = 1` giving `b`,
 * clamped to `[0,1]` — Lightroom's Amount semantics.
 */
export function blend(a: Lut3D, b: Lut3D, t: number): Lut3D {
  return blendExtrapolate(a, b, clampUnit(t));
}

/**
 * {@link blend} without clamping `t`.
 *
 * `t > 1` extrapolates past the graded look — the "200%" position on the
 * strength slider. Values that leave `[0,1]` are clamped when the samples are
 * written, so this reads as an over-driven grade rather than a color error.
 */
export function blendExtrapolate(a: Lut3D, b: Lut3D, t: number): Lut3D {
  if (a.size !== b.size) throw new RangeError("cannot blend LUTs of different sizes");
  const data = new Float32Array(a.data.length);
  for (let i = 0; i < a.data.length; i += 1) {
    const x = a.data[i];
    data[i] = x + (b.data[i] - x) * t;
  }
  return { size: a.size, data };
}

/** `f32::clamp(0, 1)`, with NaN mapped to 0. */
function clampUnit(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}
