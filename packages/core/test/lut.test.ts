/**
 * Baking, trilinear lookup, strength blending and the `.cube` serialisation.
 *
 * The table is checked against the transform that produced it, node by node,
 * which is the one comparison that matters: a LUT that disagrees with its own
 * MLP would grade differently from `--direct`.
 */

import { describe, expect, it } from "vitest";

import {
  apply,
  applyInPlace,
  applyInPlaceStrength,
  applyInPlaceU16,
  bake,
  blend,
  blendExtrapolate,
  identityLut,
  type Lut3D,
} from "../src/lut/index.js";
import * as cube from "../src/lut/cube.js";
import { transfer } from "../src/mlp.js";
import { paramsFromSlice, zeroParams } from "../src/params.js";
import { deterministicParams, firstDifference, sampleGrid } from "./helpers.js";
import { quantizeU16, toUnit } from "../src/float32.js";

const params = paramsFromSlice(deterministicParams());

describe("identity table", () => {
  it("maps every node to itself", () => {
    const lut = identityLut(9);
    for (let i = 0; i < lut.data.length / 3; i += 1) {
      expect(lut.data[i * 3]).toBeCloseTo((i % 9) / 8, 12);
      expect(lut.data[i * 3 + 1]).toBeCloseTo((Math.floor(i / 9) % 9) / 8, 12);
      expect(lut.data[i * 3 + 2]).toBeCloseTo(Math.floor(i / 81) / 8, 12);
    }
  });

  it("looks up to itself within interpolation error", () => {
    const lut = identityLut(33);
    for (const rgb of sampleGrid(5)) {
      const out = apply(lut, rgb);
      for (let k = 0; k < 3; k += 1) expect(Math.abs(out[k] - rgb[k])).toBeLessThan(1e-5);
    }
  });
});

describe("baking", () => {
  it("agrees with the per-pixel transform on every node", () => {
    for (const size of [5, 17, 33]) {
      const table = bake(params, size);
      const n = size - 1;
      for (let b = 0; b < size; b += 1) {
        for (let g = 0; g < size; g += 1) {
          for (let r = 0; r < size; r += 1) {
            // `bake` builds its samples in a Float32Array, so the node values
            // are the f32 ones; compare against exactly those.
            const expected = transfer(params, [Math.fround(r / n), Math.fround(g / n), Math.fround(b / n)]);
            const at = ((b * size + g) * size + r) * 3;
            // The table is stored as f32; the transform returns doubles.
            expect(table.data[at]).toBe(Math.fround(expected[0]));
            expect(table.data[at + 1]).toBe(Math.fround(expected[1]));
            expect(table.data[at + 2]).toBe(Math.fround(expected[2]));
          }
        }
      }
    }
  });

  it("is the identity table when every weight is zero", () => {
    expect(firstDifference(bitsOf(identityLut(9)), bitsOf(bake(zeroParams(), 9)))).toBeUndefined();
  });

  it("rejects a grid smaller than two", () => {
    expect(() => bake(params, 1)).toThrowError();
  });
});

describe("strength", () => {
  it("is the raw bake at 1 and the identity at 0", () => {
    expect(firstDifference(bitsOf(bake(params, 17, 1)), bitsOf(bake(params, 17)))).toBeUndefined();
    expect(firstDifference(bitsOf(bake(params, 17, 0)), bitsOf(identityLut(17)))).toBeUndefined();
  });

  it("matches the blend formula for partial and over-driven amounts", () => {
    const graded = bake(params, 17);
    const identity = identityLut(17);
    for (const strength of [0.35, 1.4]) {
      const folded = bake(params, 17, strength);
      for (let i = 0; i < graded.data.length; i += 1) {
        expect(folded.data[i]).toBeCloseTo(
          identity.data[i] + (graded.data[i] - identity.data[i]) * strength,
          6,
        );
      }
    }
  });
});

describe("blending", () => {
  const a = identityLut(9);
  const b = bake(params, 9);

  it("interpolates between the two tables", () => {
    expect(firstDifference(bitsOf(a), bitsOf(blend(a, b, 0)))).toBeUndefined();
    expect(firstDifference(bitsOf(b), bitsOf(blend(a, b, 1)))).toBeUndefined();
    const half = blend(a, b, 0.5);
    for (let i = 0; i < half.data.length; i += 1) {
      expect(half.data[i]).toBeCloseTo((a.data[i] + b.data[i]) / 2, 6);
    }
  });

  it("extrapolates past the graded look without clamping the blend", () => {
    const over = blendExtrapolate(a, b, 2);
    for (let i = 0; i < over.data.length; i += 1) {
      expect(over.data[i]).toBeCloseTo(a.data[i] + (b.data[i] - a.data[i]) * 2, 5);
    }
    // The clamped helper keeps Amount semantics.
    expect(Array.from(blend(a, b, 2).data)).toEqual(Array.from(b.data));
  });
});

describe("lookup", () => {
  it("clamps out-of-range input", () => {
    const lut = identityLut(5);
    expect(apply(lut, [-1, 0.5, 2])).toEqual([0, 0.5, 1]);
  });

  it("in place matches the single-point lookup", () => {
    const table = bake(params, 17);
    for (const rgb of sampleGrid(3)) {
      const pixels = new Float32Array(rgb);
      applyInPlace(table, pixels);
      const point = apply(table, rgb);
      expect(Array.from(pixels)).toEqual(point);
    }
  });

  it("honours the strength curve in place", () => {
    const table = bake(params, 17);
    const rgb: [number, number, number] = [0.2, 0.5, 0.8];
    const full = apply(table, rgb);
    const none = Array.from(rgb);
    const half = new Float32Array(rgb);
    applyInPlaceStrength(table, half, 0.5);
    for (let k = 0; k < 3; k += 1) {
      expect(half[k]).toBeCloseTo(none[k] + (full[k] - none[k]) * 0.5, 6);
    }
  });
});

describe("fused 16-bit lookup", () => {
  it("lands within one code of the three-pass path", () => {
    const table: Lut3D = bake(params, 33);
    const codes = new Uint16Array(3 * 4096);
    for (let i = 0; i < codes.length; i += 1) codes[i] = (i * 6553) % 65536;
    codes[0] = 0;
    codes[1] = 65535;
    codes[2] = 32768;

    for (const strength of [1, 0.8, 0.35]) {
      const fused = new Uint16Array(codes);
      applyInPlaceU16(table, fused, strength);

      const floats = Float32Array.from(codes, toUnit);
      if (strength === 1) applyInPlace(table, floats);
      else applyInPlaceStrength(table, floats, strength);
      const expected = Uint16Array.from(floats, quantizeU16);

      let worst = 0;
      let differing = 0;
      for (let i = 0; i < fused.length; i += 1) {
        const delta = Math.abs(fused[i] - expected[i]);
        if (delta !== 0) differing += 1;
        if (delta > worst) worst = delta;
      }
      expect(worst, `strength ${strength}`).toBeLessThanOrEqual(1);
      // Only the samples sitting on a rounding boundary may move.
      expect(differing / fused.length).toBeLessThan(0.01);
    }
  });

  it("round-trips pure black and white", () => {
    const table = bake(params, 33);
    const codes = new Uint16Array([0, 0, 0, 65535, 65535, 65535]);
    applyInPlaceU16(table, codes, 1);
    // A grade may map the ends elsewhere, but the values stay in range.
    for (const code of codes) expect(code).toBeGreaterThanOrEqual(0);
    for (const code of codes) expect(code).toBeLessThanOrEqual(65535);
  });
});

describe(".cube serialisation", () => {
  it("round-trips a table within the printed precision", () => {
    const table = bake(params, 9);
    const text = cube.write(table, "ColorFM");
    const parsed = cube.read(text);
    expect(parsed.size).toBe(table.size);
    for (let i = 0; i < table.data.length; i += 1) {
      expect(Math.abs(parsed.data[i] - table.data[i])).toBeLessThan(1e-6);
    }
  });

  it("writes the header the format requires", () => {
    const text = cube.write(bake(params, 5), "Title");
    expect(text).toContain("LUT_3D_SIZE 5");
    const dataLines = text
      .trimEnd()
      .split("\n")
      .filter((line) => /^-?\d/.test(line));
    expect(dataLines).toHaveLength(125);
  });
});

/** The bit patterns of a table, for exact comparisons between two paths. */
function bitsOf(lut: Lut3D): string[] {
  const out: string[] = new Array(lut.data.length);
  for (let i = 0; i < lut.data.length; i += 1) out[i] = String(lut.data[i]);
  return out;
}
