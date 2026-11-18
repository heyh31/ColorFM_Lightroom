/**
 * Differential tests for `float32.ts`: the activation and the exponential it is
 * built on must land on the same bits as the reference implementation, because
 * every kernel weight flows through them.
 */

import { describe, expect, it } from "vitest";

import { expf, swishf } from "../../src/float32.js";
import { bitsOf, firstDifference, reference, SKIP_WITHOUT_REFERENCE } from "./helpers.js";

/** A deterministic sweep over the range pre-activations can reach. */
function sweep(): number[] {
  const values: number[] = [];
  for (let i = 0; i < 4000; i += 1) values.push(Math.fround(-24 + i * 0.012));
  let seed = 12345;
  for (let i = 0; i < 4000; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    values.push(Math.fround((seed / 4294967296) * 48 - 24));
  }
  for (const edge of [0, 1, -1, 0.5, -0.5, 1e-7, -1e-7, 88.7, -103.9, 88.8, -104]) {
    values.push(Math.fround(edge));
  }
  return values;
}

describe.skipIf(SKIP_WITHOUT_REFERENCE)("expf", () => {
  it("matches the reference bit for bit", () => {
    const values = sweep();
    const expected = reference<{ swish: string[]; exp: string[] }>("f32ops", { values });

    const exp = values.map((value) => bitsOf(expf(value)));
    expect(firstDifference(expected.exp, exp)).toBeUndefined();

    const swish = values.map((value) => bitsOf(swishf(value)));
    expect(firstDifference(expected.swish, swish)).toBeUndefined();
  });

  it("keeps Swish equal to x * sigmoid(x) in double precision", () => {
    for (const x of [-8, -3.5, -1, -0.25, 0, 0.25, 1, 3.5, 8]) {
      const expected = x / (1 + Math.exp(-x));
      expect(Math.abs(swishf(x) - expected)).toBeLessThan(1e-6);
    }
  });
});
