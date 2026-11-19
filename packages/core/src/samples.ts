/**
 * Unit conversion and clamping for the 16-bit sample format.
 *
 * Arithmetic in the pipeline is double; the only place precision is reduced on
 * purpose is the sample format itself, at the edges — 16-bit codes in, 16-bit
 * codes out.
 */

/** The step between two 16-bit codes. */
export const UNIT_PER_CODE = 1 / 65535;

/** A 16-bit code as a unit value. */
export function toUnit(code: number): number {
  return code * UNIT_PER_CODE;
}

/** `clamp(x, 0, 1)`, with NaN mapped to 0. */
export function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

/**
 * Rounds a unit float to the nearest 16-bit code.
 *
 * Out-of-range values clamp to the ends, so a grade that extrapolates past the
 * table's range reads as an over-driven colour rather than wrapping.
 */
export function quantizeU16(value: number): number {
  if (!(value > 0)) return 0;
  if (value >= 1) return 65535;
  return (value * 65535 + 0.5) | 0;
}
